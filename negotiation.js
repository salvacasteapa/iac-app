// Motor de negociación entre el agente de compras y el agente de ventas.
// Determinista: mismas reglas, mismo resultado. Cada agente se mueve solo dentro de los límites de su gestor.

const RATE = { duro: 0.12, equilibrado: 0.25, flexible: 0.45 };
const r2 = n => Math.round(n * 100) / 100;
const eur = n => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/**
 * @param {object} p
 *  product: {name, list_price, min_price, cost, stock, lead_days}
 *  need: {qty, target_price, max_price, max_days, consumption, forecast}
 *  sellerPolicy, buyerPolicy, seller:{name}, buyer:{name}
 */
function negotiate({ product, need, sellerPolicy, buyerPolicy, seller, buyer }) {
  const log = [];
  const say = (who, text) => log.push({ who, text });
  const sp = sellerPolicy, bp = buyerPolicy;

  // Precio suelo del vendedor: el mínimo fijado o el coste + margen mínimo, lo que sea mayor.
  const costFloor = product.cost > 0 ? product.cost * (1 + (sp.margen_min_pct || 0) / 100) : 0;
  const floor = r2(Math.max(product.min_price, costFloor));
  const list = product.list_price;
  const openBook = !!sp.mostrar.costes && product.cost > 0;

  let qty = need.qty, partial = false;
  say('buy', `Necesitamos ${qty} ${product.unit || 'ud'} de ${product.name}, con entrega en ${need.max_days} días como máximo.`);

  if (qty > product.stock) {
    if (!bp.acepta_parciales || product.stock <= 0) {
      say('sell', `Ahora mismo tenemos ${product.stock} disponibles; no podemos cubrir el pedido completo.`);
      return { status: 'sin_acuerdo', motivo: 'Stock insuficiente', log };
    }
    qty = product.stock; partial = true;
    say('sell', `Podemos servir ${qty} ahora, como entrega parcial.`);
  }
  if (product.lead_days > need.max_days) {
    say('sell', `Nuestro plazo de entrega es de ${product.lead_days} días.`);
    say('buy', `Necesitamos un plazo máximo de ${need.max_days} días.`);
    return { status: 'sin_acuerdo', motivo: 'Plazo incompatible', log };
  }
  if (floor > need.max_price) {
    // Se negocia igualmente para dejar constancia, pero no habrá acuerdo.
  }

  // Velocidad de concesión del vendedor según su estilo y prioridades.
  let cs = RATE[sp.estilo] ?? RATE.equilibrado;
  const pr = sp.prioridades;
  cs *= 1 - 0.4 * (pr.margen / 100);
  const bigOrder = need.forecast && need.consumption ? need.forecast >= need.consumption * 1.1 : qty >= 100;
  if (bigOrder) cs *= 1 + 0.6 * (pr.volumen / 100);
  if (product.stock >= qty * 3) cs *= 1 + 0.6 * (pr.rotacion / 100);
  cs = Math.min(cs, 0.7);

  let cb = RATE[bp.estilo] ?? RATE.equilibrado;
  cb *= 1 - 0.3 * (bp.prioridades.precio / 100);

  if (need.forecast && need.consumption && need.forecast > need.consumption) {
    say('sell', `Vemos que vuestra previsión sube a ${need.forecast} el próximo mes. Podemos reservaros producción.`);
  }

  let s = list;
  let b = need.target_price;
  if (openBook) {
    b = Math.max(b, Math.min(need.max_price, costFloor));
    say('sell', `Trabajamos a libro abierto: nuestro coste es ${eur(product.cost)} y aplicamos un margen mínimo del ${sp.margen_min_pct}%.`);
  }
  say('sell', `Nuestra oferta: ${eur(s)} por ${product.unit || 'ud'}, entrega en ${product.lead_days} días.`);

  let price = null;
  for (let round = 1; round <= 8; round++) {
    if (s <= need.max_price && s <= b) { price = s; break; }
    say('buy', `Podemos pagar ${eur(r2(b))}.`);
    if (b >= floor && b >= s) { price = b; break; }
    s = r2(s - cs * (s - floor));
    b = r2(b + cb * (need.max_price - b));
    if (b >= s) { price = r2((s + b) / 2); say('sell', `Nos acercamos. Proponemos cerrar a ${eur(price)}.`); break; }
    say('sell', `Podemos dejarlo en ${eur(s)}.`);
    if (s <= need.max_price && (s - b) / s < 0.015) { price = s; break; }
  }
  if (price === null) {
    const gap = r2(s - b);
    say('sys', `Sin acuerdo tras 8 rondas. Diferencia: ${eur(gap)} por unidad.`);
    return { status: 'sin_acuerdo', motivo: `Diferencia de ${eur(gap)}/ud`, log, last: { seller: s, buyer: b } };
  }
  price = r2(Math.min(need.max_price, Math.max(floor, price)));
  const total = r2(price * qty);
  say('buy', `De acuerdo: ${qty} a ${eur(price)}. Total ${eur(total)}.`);

  const discountPct = r2((1 - price / list) * 100);
  return { status: 'acuerdo', price, qty, total, partial, lead_days: product.lead_days, discountPct, log };
}

/** Puntuación del comprador para elegir entre varias ofertas (0-100). */
function scoreOffers(offers, need, buyerPolicy) {
  const w = buyerPolicy.prioridades;
  const sum = (w.precio + w.plazo + w.fiabilidad) || 1;
  const maxOrders = Math.max(1, ...offers.map(o => o.pastOrders || 0));
  for (const o of offers) {
    const priceScore = Math.max(0, Math.min(1, (need.max_price - o.price) / Math.max(0.01, need.max_price - need.target_price)));
    const leadScore = Math.max(0, 1 - o.lead_days / Math.max(1, need.max_days));
    const relScore = (o.pastOrders || 0) / maxOrders;
    o.score = r2(100 * (w.precio * priceScore + w.plazo * leadScore + w.fiabilidad * relScore) / sum);
  }
  return offers.sort((a, b) => b.score - a.score);
}

/** ¿Necesita aprobación humana cada lado? */
function approvals(result, sellerPolicy, buyerPolicy) {
  const sc = sellerPolicy.cierre, bc = buyerPolicy.cierre;
  const seller = sc.modo === 'aprobacion' || result.discountPct > sc.descuento_max_auto || result.total > sc.importe_max_auto;
  const buyer = bc.modo === 'aprobacion' || result.total > bc.importe_max_auto;
  return { seller, buyer };
}

module.exports = { negotiate, scoreOffers, approvals };
