// Fórmula de precio de venta para productos de AliExpress Dropshipping.
// Módulo puro (sin red ni estado), todavía no usado por la aplicación de producción.
//
// Definiciones:
//   margen  = ganancia / ingreso neto (sin impuesto de venta)   ← lo que se configura
//   recargo = ganancia / costo                                   ← solo se informa
//
// Precio bruto G (lo que paga el comprador, impuesto de venta incluido):
//   Costo   = (costo_unitario × cantidad + envío + cargos_extra) × tipo_cambio × (1 + colchón_cambiario)
//   Fijos   = pasarela.fijo × (1 + iva_comisiones) + plataforma.fijo
//   v       = pasarela.pct × (1 + iva_comisiones) + plataforma.pct          (se cobran sobre G)
//   G       = (Costo + Fijos) / ((1 − margen) / (1 + impuesto_venta) − v)
// y luego se redondea HACIA ARRIBA al escalón de precio, por lo que el margen real ≥ margen pedido.

// Precio de compra unitario según la doc oficial (docId=1669): offer_sale_price para una
// unidad; wholesale_price si la cantidad alcanza min_quantity de algún escalón.
export function unitCostFor(sku, quantity = 1) {
  let cost = sku.offer_sale_price ?? sku.sku_price;
  for (const tier of sku.wholesale_tiers || []) {
    if (tier.min_quantity != null && tier.wholesale_price != null && quantity >= tier.min_quantity && tier.wholesale_price < cost) {
      cost = tier.wholesale_price;
    }
  }
  if (!Number.isFinite(cost) || cost <= 0) throw new Error("La variante no tiene un precio de compra válido.");
  return cost;
}

// Cargos que AliExpress informa aparte del precio (docId=1669):
//   - estimated_import_charges informado ⇒ el precio NO los incluye ⇒ se suman.
//   - price_include_tax === false con tax_amount ⇒ se suma tax_amount.
export function extraChargesFor(sku, quantity = 1) {
  let extra = 0;
  if (Number.isFinite(sku.estimated_import_charges) && sku.estimated_import_charges > 0) extra += sku.estimated_import_charges * quantity;
  if (sku.price_include_tax === false && Number.isFinite(sku.tax_amount) && sku.tax_amount > 0) extra += sku.tax_amount * quantity;
  return extra;
}

// Redondeo hacia arriba a un escalón con terminación: step=10, ending=9 → …9; step=1, ending=0.99 → x.99.
export function roundUpPrice(raw, { step = 1, ending = 0 } = {}) {
  if (!(step > 0) || ending < 0 || ending >= step) throw new Error("Redondeo inválido: se requiere 0 ≤ ending < step.");
  const k = Math.ceil((raw - ending) / step - 1e-9);
  return round2(k * step + ending);
}

export function computePrice(input) {
  const {
    unitCost, quantity = 1, shipping = 0, extraCharges = 0,
    fxRate, fxBuffer = 0,
    gateway = { pct: 0, fixed: 0 }, vatOnFees = 0,
    platform = { pct: 0, fixed: 0 },
    salesTax = 0, margin,
    rounding = { step: 0.01, ending: 0 },
  } = input;

  for (const [name, v] of Object.entries({ unitCost, fxRate, margin })) {
    if (!Number.isFinite(v)) throw new Error(`Falta ${name}.`);
  }
  if (unitCost <= 0 || fxRate <= 0) throw new Error("Costo y tipo de cambio deben ser positivos.");
  if (margin < 0 || margin >= 1) throw new Error("El margen se expresa como fracción del ingreso neto: 0 ≤ margen < 1.");

  const supplierTotal = unitCost * quantity + shipping + extraCharges;
  const cost = supplierTotal * fxRate * (1 + fxBuffer);
  const fixedFees = (gateway.fixed || 0) * (1 + vatOnFees) + (platform.fixed || 0);
  const variableRate = (gateway.pct || 0) * (1 + vatOnFees) + (platform.pct || 0);
  const denominator = (1 - margin) / (1 + salesTax) - variableRate;
  if (denominator <= 0) throw new Error("Margen + comisiones + impuesto superan el 100 % del precio: no existe precio que cumpla.");

  const rawPrice = (cost + fixedFees) / denominator;
  const price = roundUpPrice(rawPrice, rounding);
  return { rawPrice: round2(rawPrice), price, supplierTotal: round2(supplierTotal), ...breakdown(price, { cost, fixedFees, variableRate, gateway, vatOnFees, platform, salesTax }) };
}

// Desglose de un precio dado (sirve para verificar la fórmula hacia atrás).
export function breakdown(price, { cost, gateway, vatOnFees = 0, platform, salesTax = 0 }) {
  const netRevenue = price / (1 + salesTax);
  const salesTaxAmount = price - netRevenue;
  const gatewayFee = ((gateway.pct || 0) * price + (gateway.fixed || 0)) * (1 + vatOnFees);
  const platformFee = (platform.pct || 0) * price + (platform.fixed || 0);
  const profit = netRevenue - gatewayFee - platformFee - cost;
  return {
    cost: round2(cost),
    salesTaxAmount: round2(salesTaxAmount),
    netRevenue: round2(netRevenue),
    gatewayFee: round2(gatewayFee),
    platformFee: round2(platformFee),
    profit: round2(profit),
    margin: profit / netRevenue,
    markup: profit / cost,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
