# Copresentar

Página estática (HTML, CSS y JS, sin servidor propio) para presentar un PDF y que **otra persona controle las diapositivas en tiempo real** desde su compu o su celular, mientras vos compartís la pantalla en Zoom o Meet.

## Publicar en GitHub Pages (5 minutos)

1. En GitHub: **New repository** → nombre `copresentar` → **Public** → *Create repository*.
2. En el repo vacío: **uploading an existing file** → arrastrá **todo el contenido** de esta carpeta (`index.html`, `css/`, `js/`, `vendor/`, `.nojekyll`, `README.md`) → *Commit changes*.
   - Tienen que quedar en la raíz del repo (no dentro de otra carpeta).
   - `.nojekyll` es un archivo oculto; si tu sistema no lo muestra no pasa nada, la página funciona igual.
3. **Settings → Pages** → *Source: Deploy from a branch* → Branch `main`, carpeta `/ (root)` → *Save*.
4. En 1 o 2 minutos queda en `https://TU-USUARIO.github.io/copresentar/`.

## Uso el día de la ponencia

1. Exportá el PowerPoint a PDF (Archivo → Exportar → PDF). Una página = una diapositiva.
2. Quien comparte pantalla abre la página, escribe su nombre y carga el PDF.
3. Copia el **enlace de control** y se lo pasa al colega (WhatsApp, chat de la reunión).
4. El colega abre el enlace (compu o celular). Si quiere ver las diapositivas en su pantalla, carga el mismo PDF (es opcional).
5. Compartir en Zoom: *Compartir pantalla* → la ventana del navegador. En Meet: *Presentar → Una pestaña* → esta pestaña.
6. Tecla **F**: pantalla completa. Los dos avanzan y retroceden con botones o flechas (también funcionan los punteros/clickers).

Atajos del presentador: `→ ↓ PgDn Espacio` siguiente · `← ↑ PgUp` anterior · `Inicio/Fin` · número + `Enter` para saltar · `B` pantalla negra · `F` pantalla completa.

**Si se recarga la página del presentador**, se vuelve a elegir el mismo PDF y se retoma en la misma diapositiva; el enlace del colega sigue funcionando.

## Prueba previa recomendada (2 minutos, un día antes)

Hacela con las mismas computadoras y redes del congreso:
- La barra del presentador tiene que decir **Conectado (2/4)** o más (verde). Pasá el mouse por arriba del indicador para ver qué servidores respondieron.
- El colega abre el enlace: tiene que decir *Conectado con …* y mostrar el número de diapositiva.
- Avancen una vez cada uno.

## Cómo funciona

- El PDF se dibuja en el navegador con [PDF.js](https://mozilla.github.io/pdf.js/) (incluido en `vendor/`, licencia Apache 2.0). **El archivo nunca se sube a internet.**
- Por la red solo viajan mensajes cortos («ir a la diapositiva 5»). Se envían a la vez por varios servidores públicos gratuitos y se descartan los duplicados, así alcanza con que funcione uno:
  - Brokers MQTT por WebSocket seguro: HiveMQ (puerto 8884), EMQX (8084), Mosquitto (8081).
  - ntfy.sh por el puerto 443, como respaldo si la red de la institución bloquea los otros puertos.
- La sala es un código aleatorio de 10 caracteres. Cualquiera que tenga el enlace puede mover las diapositivas: compartilo solo con tu copresentador.

## Limitaciones

- No reproduce animaciones ni videos internos del PowerPoint (el PDF es estático). Para una animación por pasos, duplicá la diapositiva con cada paso antes de exportar.
- Depende de servidores públicos gratuitos sin garantía de disponibilidad; por eso usa cuatro en paralelo.
