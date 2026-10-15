// Cotización de solo lectura: costo por variante + opciones de envío.
// Ruta: GET /api/aliexpress/quote?product_id=&country=&sku_id=&quantity=&currency=&account=
//
// Usa aliexpress.ds.product.get y aliexpress.ds.freight.query (sin costo, no crea pedidos,
// no escribe en KV). Protegido con "Authorization: Bearer <ALIEXPRESS_ADMIN_KEY>".
//
// Docs oficiales:
//   https://openservice.aliexpress.com/doc/api.htm#/api?cid=21038&path=aliexpress.ds.product.get&methodType=GET/POST
//   https://openservice.aliexpress.com/doc/api.htm#/api?cid=21038&path=aliexpress.ds.freight.query&methodType=GET/POST
//   Precio de compra (offer_sale_price / wholesale_price): https://openservice.aliexpress.com/doc/doc.htm#/?docId=1669

import { isAuthorized, json } from "./test-product.js";
import { accountSummary, callBusinessApi, gatewayError, resolveAccountKey } from "./admin-lib.js";

export async function onRequestGet({ request, env }) {
  if (!(await isAuthorized(request, env.ALIEXPRESS_ADMIN_KEY))) {
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET || !env.ALIEXPRESS_TOKENS) {
    return json(500, { ok: false, error: "missing_configuration" });
  }

  const q = new URL(request.url).searchParams;
  const productId = q.get("product_id") || "";
  const country = (q.get("country") || "").toUpperCase();
  const skuId = q.get("sku_id");
  const quantity = q.get("quantity") || "1";
  const currency = (q.get("currency") || "USD").toUpperCase();
  if (!/^\d{1,20}$/.test(productId) || !/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency) ||
      !/^\d{1,3}$/.test(quantity) || Number(quantity) < 1 || (skuId !== null && !/^\d{1,30}$/.test(skuId))) {
    return json(400, { ok: false, error: "invalid_parameters", required: "product_id, country (ISO-2)", optional: "sku_id, quantity, currency, account" });
  }

  const { key, error } = await resolveAccountKey(env.ALIEXPRESS_TOKENS, q.get("account"));
  if (error) return json(400, { ok: false, error });
  const stored = await env.ALIEXPRESS_TOKENS.get(key, "json");
  if (!stored?.access_token) return json(404, { ok: false, error: "account_not_found" });

  const query = { product_id: productId, ship_to_country: country, quantity: Number(quantity), currency };
  let productData;
  try {
    productData = await callBusinessApi(env, stored.access_token, "aliexpress.ds.product.get", {
      product_id: productId, ship_to_country: country, target_currency: currency, target_language: "en",
    });
  } catch (err) {
    console.error("AliExpress quote: fallo en ds.product.get:", err.name);
    return json(502, { ok: false, stage: "product", error: "request_failed", query });
  }

  const product = parseProduct(productData);
  if (!product.ok) {
    console.error(`AliExpress quote: product ${product.error_code} request_id=${product.request_id || "-"}`);
    return json(502, { ok: false, stage: "product", ...product, query, account: accountSummary(stored) });
  }

  const sku = skuId ? product.skus.find((s) => s.sku_id === skuId) : product.skus.find((s) => s.stock > 0) || product.skus[0];
  if (!sku) return json(404, { ok: false, stage: "product", error: "sku_not_found", skus: product.skus, query });

  let freightData;
  try {
    freightData = await callBusinessApi(env, stored.access_token, "aliexpress.ds.freight.query", {
      queryDeliveryReq: JSON.stringify({
        productId, selectedSkuId: sku.sku_id, quantity: Number(quantity), shipToCountry: country,
        currency, language: "en_US", locale: "en_US",
      }),
    });
  } catch (err) {
    console.error("AliExpress quote: fallo en ds.freight.query:", err.name);
    return json(502, { ok: false, stage: "freight", error: "request_failed", product: product.info, selected_sku: sku, query });
  }

  const freight = parseFreight(freightData);
  if (!freight.ok) console.error(`AliExpress quote: freight ${freight.error_code} request_id=${freight.request_id || "-"}`);

  return json(freight.ok ? 200 : 502, {
    ok: freight.ok,
    stage: freight.ok ? "done" : "freight",
    query,
    account: accountSummary(stored),
    product: product.info,
    product_request_id: product.request_id,
    skus: product.skus,
    selected_sku: sku,
    freight,
  });
}

export function parseProduct(data) {
  const gw = gatewayError(data);
  if (gw) return { ok: false, ...gw };
  const wrapper = data?.aliexpress_ds_product_get_response;
  const result = wrapper?.result;
  if (!result || (wrapper.rsp_code !== undefined && String(wrapper.rsp_code) !== "200")) {
    return { ok: false, error_code: String(wrapper?.rsp_code || "unknown_response"), error_message: wrapper?.rsp_msg || null, request_id: wrapper?.request_id || null };
  }
  const raw = result.ae_item_sku_info_dtos;
  const list = Array.isArray(raw) ? raw : raw?.ae_item_sku_info_d_t_o || [];
  const skus = list.map((s) => {
    const propsRaw = s.ae_sku_property_dtos;
    const props = Array.isArray(propsRaw) ? propsRaw : propsRaw?.ae_sku_property_d_t_o || [];
    const tiersRaw = s.wholesale_price_tiers;
    const tiers = Array.isArray(tiersRaw) ? tiersRaw : tiersRaw?.wholesale_price_tier || [];
    return {
      sku_id: s.sku_id != null ? String(s.sku_id) : null,
      attributes: props.map((p) => `${p.sku_property_name}: ${p.property_value_definition_name || p.sku_property_value}`).join(" / ") || null,
      offer_sale_price: num(s.offer_sale_price),
      sku_price: num(s.sku_price),
      currency: s.currency_code || null,
      stock: s.sku_available_stock != null ? Number(s.sku_available_stock) : null,
      price_include_tax: s.price_include_tax ?? null,
      tax_amount: num(s.tax_amount),
      tax_currency: s.tax_currency_code || null,
      estimated_import_charges: num(s.estimated_import_charges),
      wholesale_tiers: tiers.map((t) => ({ min_quantity: num(t.min_quantity), wholesale_price: num(t.wholesale_price) })),
    };
  });
  const base = result.ae_item_base_info_dto || {};
  return {
    ok: true,
    request_id: wrapper.request_id || data.request_id || null,
    info: {
      product_id: base.product_id ?? null,
      title: base.subject ?? null,
      status: base.product_status_type ?? null,
      store_country: result.ae_store_info?.store_country_code ?? null,
    },
    skus,
  };
}

export function parseFreight(data) {
  const gw = gatewayError(data);
  if (gw) return { ok: false, ...gw };
  const wrapper = data?.aliexpress_ds_freight_query_response;
  const result = wrapper?.result;
  if (!result || result.success === false || (result.code !== undefined && Number(result.code) !== 200)) {
    return { ok: false, error_code: String(result?.code ?? "unknown_response"), error_message: result?.msg || null, request_id: wrapper?.request_id || null };
  }
  const raw = result.delivery_options;
  const list = Array.isArray(raw) ? raw : raw?.delivery_option_d_t_o || [];
  return {
    ok: true,
    request_id: wrapper.request_id || data.request_id || null,
    options: list.map((o) => ({
      code: o.code ?? null,
      company: o.company ?? null,
      free_shipping: o.free_shipping ?? null,
      // La doc dice "amount in cent"; se incluyen el valor crudo y el formateado para verificarlo con datos reales.
      shipping_fee: o.shipping_fee_cent != null ? Number(o.shipping_fee_cent) / 100 : null,
      shipping_fee_cent_raw: o.shipping_fee_cent ?? null,
      shipping_fee_format: o.shipping_fee_format ?? null,
      shipping_fee_currency: o.shipping_fee_currency ?? null,
      min_delivery_days: o.min_delivery_days ?? null,
      max_delivery_days: o.max_delivery_days ?? null,
      tracking: o.tracking ?? null,
      ship_from_country: o.ship_from_country ?? null,
      ddp_include_vat_tax: o.ddpIncludeVATTax ?? null,
    })),
  };
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
