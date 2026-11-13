# Borrador de postulación – NEAR HACKATHON (NO ENVIADO)

> Notas en español para José Ignacio. Los textos para copiar están en inglés.
> Nada de esto se publicó ni se envió. El formulario se envía **una sola vez**.
> Cierre: **sábado 14-nov-2026, 20:59 hora de Chile** (23:59 UTC). Conviene enviarlo en la mañana.

## Checklist antes de enviar

- [ ] Repo `drmessi007-ui/orbithire` **público** (hoy está privado). Los jueces no pueden abrir repos privados.
- [ ] Revisar el README y el `docs/SECURITY.md`, y confirmar que la demo en vivo y el agente siguen arriba hasta el 18 de noviembre (ideal: hasta el 25).
- [ ] Grabar el video: conectar Meteor → preguntar "¿A qué hora pasa la ISS sobre Osorno?" → pagar 0.1 NEAR → ver las etapas → informe y enlace a la transacción.
- [ ] Publicar el post en X con el video (texto abajo).
- [ ] Tener la **cuenta NEAR de mainnet** para el premio (distinta de la de testnet).
- [ ] Llenar el formulario en https://nearhackathon.com/#apply.

## Campos del formulario

| Campo | Valor sugerido |
| --- | --- |
| Project name | OrbitHire |
| Team lead | José Ignacio García Ojeda |
| Email | (tu correo) |
| Team size | 1 |
| Tracks | `agents` (opcional: `business`) |
| NEAR mainnet account | (tu cuenta `.near` o implícita de mainnet; **no** la de testnet) |
| Repo link | https://github.com/drmessi007-ui/orbithire (una vez público) |
| X post link | (link del post una vez publicado) |
| Description | texto de abajo |

### Description (English, ~1,200 characters; the limit is 20–2000)

```
OrbitHire lets anyone hire an autonomous space-data agent and pay it on NEAR, with escrow and an on-chain receipt. A user connects Meteor Wallet on testnet, asks a question (next ISS pass over a Chilean city such as Santiago or Osorno, or the current geomagnetic storm level) and pays a fixed 0.1 NEAR fee to the OrbitHire contract. The fee is held in escrow, not paid to the agent. The off-chain agent (Node.js) independently verifies the payment on-chain: transaction success, target contract, exact fee and the SHA-256 commitment of the query. It then fetches real public data (NOAA SWPC Kp index, or CelesTrak orbital elements propagated with satellite.js) and signs submit_report with the report hash. That moves the fee into a separate treasury contract, and confirm_report_received releases it to the agent. If the agent never delivers, the requester can claim a refund after 24 hours. A per-account rate limit (1 request per hour) protects the agent and its data sources. The web page shows live progress stages, the report, the transaction link and a per-wallet history. Two Rust contracts (near-sdk 5.30.1) with 39 unit tests, an agent with 24 tests, and a live demo on GitHub Pages. Testnet only, not audited.
```

## Post en X (borrador, inglés)

Opción corta (menos de 280 caracteres, con el video adjunto):

```
Built at NEAR HACKATHON: OrbitHire 🛰️ Hire an AI space-data agent and pay it on @NEARProtocol. The fee sits in escrow; the agent verifies payment on-chain, fetches NOAA/CelesTrak data and gets paid only after posting a report receipt. Demo ⬇️ #NEARHackathon
```

Línea opcional de respuesta (hilo) con los links:

```
Live demo (testnet): https://drmessi007-ui.github.io/orbithire-frontend/
Code: https://github.com/drmessi007-ui/orbithire
```

Notas:
- Revisa que el primer texto no pase los 280 caracteres después de pegarlo (X cuenta los links como 23).
- Etiquetas opcionales que acepta el hackathon: `@NearLegion`, `@NearBuilders`.
- Adjunta el video al post. Si la demo en vivo se cae, el video es obligatorio.
