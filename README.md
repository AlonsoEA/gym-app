# Gym

Web app sencilla para apuntar los entrenamientos del gimnasio desde el iPhone.

## Qué hace

- **Hoy**: al abrirla ves la fecha de hoy. Eliges qué grupos musculares entrenas (Pecho, Tríceps…) o tocas una de tus combinaciones habituales.
- **Ejercicios con el nombre que tú quieras**: cada uno crea sus ejercicios dentro de cada grupo muscular, desde la pestaña *Ejercicios* o directamente al entrenar.
- **Series automáticas**: al añadir un ejercicio se crean 4 series con el peso y las repeticiones de la última vez. Con *+ Serie* añades una más ese día.
- **"Última vez"**: debajo de cada ejercicio ves lo que hiciste la última vez.
- **Calendario**: los días entrenados aparecen marcados con sus grupos. Toca un día para ver o editar lo que hiciste.
- **Copia de seguridad**: exporta e importa tus datos desde *Ajustes*.

Los datos se guardan solo en el propio iPhone y no se suben a ningún servidor.

## Instalar en el iPhone

1. Abre la dirección de la app en **Safari**.
2. Toca **Compartir** (el cuadrado con la flecha) → **Añadir a pantalla de inicio**.
3. Ábrela siempre desde el icono.

## Publicar con GitHub Pages

Ve a *Settings → Pages* en el repositorio. En *Source* elige *Deploy from a branch*, la rama `main` y la carpeta `/ (root)`.

## Actualizar la app

Después de cambiar algo, sube el número de `CACHE` en `sw.js` (por ejemplo `gym-v2`). Así el iPhone descarga la versión nueva.
