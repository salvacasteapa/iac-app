# IAC · Agentes de compra y venta

Aplicación web para empresas: cada cliente tiene su **agente de compras**, cada proveedor su **agente de ventas**, y los dos negocian pedidos recurrentes dentro de las reglas que fijan sus jefes. Cada empresa trabaja con su propio membrete y paga una membresía.

## Qué incluye

- **Cuentas de empresa** (compradora, vendedora o ambas) con varios usuarios.
- **Membrete propio**: logo, color, CIF, dirección. Se aplica al panel, a las invitaciones y a los pedidos imprimibles.
- **Reglas de los agentes**:
  - *Qué enseñar*: catálogo, stock, plazo y costes (libro abierto) en ventas; consumo, previsión y stock en compras.
  - *Cómo cerrar*: automático dentro de límites o siempre con aprobación; descuento e importe máximos sin aprobación.
  - *Qué priorizar*: margen, volumen y rotación de stock en ventas; precio, plazo y proveedor habitual en compras.
  - *Precios*: lista, mínimo y coste por producto; margen mínimo sobre coste; precio objetivo y máximo en cada compra.
  - *Instrucciones en lenguaje natural* (opcional, con clave de API).
- **Conexiones**: el proveedor invita al cliente con un enlace o por código, y el cliente autoriza, pausa o rechaza.
- **Negociación** entre agentes con registro de la conversación, elección de la mejor oferta y aprobaciones.
- **Pedidos con membrete**, listos para imprimir o guardar en PDF.
- **Membresías** con Stripe (o modo demostración sin cobro) y **panel de administración** para el dueño de la plataforma.

La interfaz no menciona inteligencia artificial: los usuarios ven "agente de compras" y "agente de ventas" de su empresa.

## Probar en tu ordenador

Requiere Node.js 22 o superior.

```bash
npm install
ADMIN_EMAIL=tu@email.com npm start
# abre http://localhost:8080
```

`npm test` ejecuta una prueba completa (proveedor, cliente, conexión, negociación y aprobación).

## Publicar en internet

La app guarda los datos en un archivo SQLite dentro de `DATA_DIR`. El servidor necesita un **disco persistente**.

### Opción A · Render (la más sencilla, unos 7-8 $/mes)
1. Sube esta carpeta a un repositorio de GitHub.
2. En render.com, elige **New → Blueprint** y selecciona el repositorio. Render lee `render.yaml` y crea el servicio con su disco.
3. Rellena `ADMIN_EMAIL` y `BASE_URL`. `BASE_URL` es la dirección que te da Render o tu dominio.
4. Regístrate en la app con tu `ADMIN_EMAIL`. Verás **Administración IAC**.

### Opción B · Google Cloud (máquina virtual con Docker)
1. En console.cloud.google.com, crea una VM en Compute Engine. La `e2-micro` entra en la capa gratuita en algunas regiones.
2. Instala Docker y copia esta carpeta.
3. Ejecuta `docker build -t iac . && docker run -d --restart=always -p 80:8080 -v /srv/iac:/data --env-file .env iac`.
4. Apunta tu dominio a la IP de la VM. Pon HTTPS, por ejemplo con Caddy delante.

> Cloud Run no sirve tal cual, porque su disco se borra. Para usarlo habría que cambiar SQLite por Cloud SQL o Firestore.

## Cobrar las membresías (Stripe)
1. En Stripe, crea tres productos con precio mensual recurrente: Compras, Ventas y Compras + Ventas. Copia sus `price_…` en `STRIPE_PRICE_COMPRADOR`, `STRIPE_PRICE_VENDEDOR` y `STRIPE_PRICE_EMPRESA`.
2. Pon `STRIPE_SECRET_KEY`.
3. Crea un webhook a `https://tu-dominio/stripe/webhook` con los eventos `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed` y `customer.subscription.deleted`. Copia su secreto en `STRIPE_WEBHOOK_SECRET`.

Sin Stripe configurado, al elegir un plan se activan 30 días sin cobro (modo demostración).

## Variables de entorno
Están en `.env.example`.

## Avisos fuera de la app

- **Notificaciones push (gratis):** no hay que configurar nada. Cada usuario las activa en «Avisos y seguimiento → Cómo me llegan». En iPhone, primero «Añadir a pantalla de inicio».
- **WhatsApp (extra de pago):** añade en Render → Environment `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` y, si cambia, `WHATSAPP_TEMPLATE` (por defecto `aviso_iac`). La plantilla debe tener 3 variables: título, detalle y enlace. Después, en «Administración IAC», activa el extra para cada empresa que lo pague; ahí ves cuántos mensajes ha enviado este mes.

## Integraciones (CRM, ERP, SAP Business One)

Página **Integraciones** (solo administradores):

- **SAP Business One** (`sapb1.js`): se conecta al Service Layer (`https://servidor:50000/b1s/v1`). Trae grupos de artículos como familias, artículos de venta con precio de la lista elegida, stock, unidad y EAN; enlaza clientes y proveedores por NIF (o a mano por CardCode) y trae su grupo. Cada pedido cerrado se crea en SAP como `Orders` (ventas) o `PurchaseOrders` (compras, con el código de artículo del cliente). Sincroniza cada 60 min o a mano. La contraseña se guarda cifrada con `SECRET_KEY` (o `DATA_DIR/secret.key`).
- **API**: claves `iac_…` en la cabecera `Authorization: Bearer`. Funcionan en todas las rutas `/api`. Rutas para sincronizar: `POST /api/v1/articulos/lote`, `POST /api/v1/clientes/lote`, `GET /api/v1/pedidos`, `GET /api/v1/clientes`.
- **Webhooks** firmados (`X-IAC-Signature: t=…,v1=HMAC-SHA256(t.cuerpo)`): pedido.cerrado / pendiente / perdido, oferta.enviada / recibida, cita.creada, aviso.creado, conexion.solicitada, articulos.sincronizados.
- **Excel**: importar artículos y grupos de clientes en CSV (`;` y coma decimal), exportar catálogo y pedidos.
