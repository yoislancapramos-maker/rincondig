// Pruebas de lib/pricing.mjs. Ejecutar con: node --test tests/pricing.test.mjs
// Todos los valores son ILUSTRATIVOS (no son tarifas ni precios reales confirmados).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePrice, breakdown, roundUpPrice, unitCostFor, extraChargesFor } from "../lib/pricing.mjs";

const close = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("ejemplo A (ilustrativo): venta en UYU con pasarela 4,99 % + IVA 22 % y comisión RD 5 %", () => {
  // Costo USD 8,50 + envío USD 2,30 = 10,80; TC 40; colchón 3 % ⇒ costo UYU 444,96.
  // v = 0,0499 × 1,22 + 0,05 = 0,110878; denominador = 0,75 − 0,110878 = 0,639122.
  // Precio crudo = 444,96 / 0,639122 = 696,21 ⇒ redondeo a …9 hacia arriba = 699.
  const r = computePrice({
    unitCost: 8.5, shipping: 2.3, fxRate: 40, fxBuffer: 0.03,
    gateway: { pct: 0.0499, fixed: 0 }, vatOnFees: 0.22,
    platform: { pct: 0.05, fixed: 0 },
    margin: 0.25, rounding: { step: 10, ending: 9 },
  });
  assert.equal(r.supplierTotal, 10.8);
  assert.equal(r.cost, 444.96);
  close(r.rawPrice, 696.21);
  assert.equal(r.price, 699);
  assert.equal(r.gatewayFee, 42.55);
  assert.equal(r.platformFee, 34.95);
  assert.equal(r.profit, 176.54);
  assert.ok(r.margin >= 0.25);
  close(r.margin, 0.2526, 0.0001);
  close(r.markup, 0.3967, 0.0001);
});

test("ejemplo B (ilustrativo): venta en USD con pasarela 2,9 % + 0,30 y precio terminado en .99", () => {
  // Costo 12,40 + envío 3,10 = 15,50; fijos 0,30; v = 0,029; denominador = 0,70 − 0,029 = 0,671.
  // Precio crudo = 15,80 / 0,671 = 23,55 ⇒ 23,99.
  const r = computePrice({
    unitCost: 12.4, shipping: 3.1, fxRate: 1,
    gateway: { pct: 0.029, fixed: 0.3 },
    margin: 0.3, rounding: { step: 1, ending: 0.99 },
  });
  close(r.rawPrice, 23.55);
  assert.equal(r.price, 23.99);
  assert.equal(r.gatewayFee, 1);
  assert.equal(r.profit, 7.49);
  assert.ok(r.margin >= 0.3);
});

test("sin redondeo, el precio crudo da exactamente el margen pedido (con IVA de venta incluido)", () => {
  const cfg = {
    unitCost: 9.99, quantity: 2, shipping: 4.5, extraCharges: 1.2, fxRate: 0.92, fxBuffer: 0.02,
    gateway: { pct: 0.034, fixed: 0.35 }, vatOnFees: 0.21, platform: { pct: 0.04, fixed: 0.5 },
    salesTax: 0.21, margin: 0.28,
  };
  const r = computePrice({ ...cfg, rounding: { step: 0.01, ending: 0 } });
  const exactCost = (9.99 * 2 + 4.5 + 1.2) * 0.92 * 1.02;
  const exactRaw = (exactCost + 0.35 * 1.21 + 0.5) / ((1 - 0.28) / 1.21 - (0.034 * 1.21 + 0.04));
  close(exactRaw, r.rawPrice, 0.006);
  close(breakdown(exactRaw, { ...cfg, cost: exactCost }).margin, 0.28, 1e-9);
  assert.ok(r.margin >= 0.28 - 1e-6);
});

test("el redondeo siempre sube: el margen real nunca queda por debajo del pedido", () => {
  for (let cost = 1; cost <= 200; cost += 7.3) {
    for (const rounding of [{ step: 1, ending: 0.99 }, { step: 10, ending: 9 }, { step: 0.05, ending: 0 }]) {
      const r = computePrice({ unitCost: cost, fxRate: 37.5, fxBuffer: 0.04, gateway: { pct: 0.0599, fixed: 0 }, vatOnFees: 0.22, margin: 0.2, rounding });
      assert.ok(r.price >= r.rawPrice, `${r.price} < ${r.rawPrice}`);
      assert.ok(r.margin >= 0.2 - 1e-9, `margen ${r.margin} con costo ${cost}`);
    }
  }
});

test("margen sobre precio ≠ recargo sobre costo", () => {
  // Recargo de 25 % sobre costo, sin comisiones: precio 125 sobre costo 100 ⇒ margen 20 %, no 25 %.
  const b = breakdown(125, { cost: 100, gateway: { pct: 0, fixed: 0 }, platform: { pct: 0, fixed: 0 } });
  close(b.markup, 0.25, 1e-12);
  close(b.margin, 0.2, 1e-12);
  // Con margen 25 % el precio debe ser 133,33, no 125.
  const r = computePrice({ unitCost: 100, fxRate: 1, margin: 0.25 });
  assert.equal(r.price, 133.34);
});

test("rechaza configuraciones imposibles o incompletas", () => {
  assert.throws(() => computePrice({ unitCost: 10, fxRate: 1, margin: 0.9, gateway: { pct: 0.1, fixed: 0 } }), /superan el 100 %/);
  assert.throws(() => computePrice({ unitCost: 10, fxRate: 1, margin: 25 }), /fracción/);
  assert.throws(() => computePrice({ unitCost: 10, margin: 0.2 }), /fxRate/);
  assert.throws(() => roundUpPrice(10, { step: 1, ending: 1 }));
});

test("costo unitario: offer_sale_price o escalón mayorista si la cantidad lo alcanza", () => {
  const sku = { offer_sale_price: 5, sku_price: 7, wholesale_tiers: [{ min_quantity: 10, wholesale_price: 4.2 }, { min_quantity: 50, wholesale_price: 3.9 }] };
  assert.equal(unitCostFor(sku, 1), 5);
  assert.equal(unitCostFor(sku, 10), 4.2);
  assert.equal(unitCostFor(sku, 60), 3.9);
  assert.equal(unitCostFor({ offer_sale_price: null, sku_price: 7 }), 7);
  assert.throws(() => unitCostFor({ offer_sale_price: null, sku_price: null }));
});

test("cargos extra: se suman solo si AliExpress los informa fuera del precio", () => {
  assert.equal(extraChargesFor({ estimated_import_charges: null, price_include_tax: true, tax_amount: 2 }), 0);
  assert.equal(extraChargesFor({ estimated_import_charges: 1.5, price_include_tax: true }, 2), 3);
  assert.equal(extraChargesFor({ estimated_import_charges: null, price_include_tax: false, tax_amount: 0.8 }, 1), 0.8);
});

test("redondeo con terminaciones", () => {
  assert.equal(roundUpPrice(696.21, { step: 10, ending: 9 }), 699);
  assert.equal(roundUpPrice(699, { step: 10, ending: 9 }), 699);
  assert.equal(roundUpPrice(23.55, { step: 1, ending: 0.99 }), 23.99);
  assert.equal(roundUpPrice(23.99, { step: 1, ending: 0.99 }), 23.99);
  assert.equal(roundUpPrice(10.01, { step: 0.05, ending: 0 }), 10.05);
});
