#!/bin/bash
# Instrucciones de uso:
# 1 - Loguearse con "cf login". No importa la sub cuenta y space seleccionado
# 2 - CAmbiar el APP_NAME por la instancia srv de la cap a debugear
# 2.5 - Cambiar el PROCESS_ID en el segundo "grep" para que tome solamente el proceso correcto para matar
# 3 - Se invoca de la siguiente manera: ./debug-app.sh
# 4 - El script realiza lo correspondiente para dejar ejecutando la instancia en consola.

# Nombre de la aplicación en SAP BTP
environment="$1"

case $environment in
  "dev")
    APP_NAME="soautomation-cap-srv"
    ;;
  "qas")
    APP_NAME="soautomation-cap-srv"
    ;;
  "prd")
    APP_NAME="soautomation-cap-srv"
    ;;
  *)
    printf "Invalid environment: %s\n" "$environment"
    printf "Usage: $0 {dev|qa|prd}\n"
    exit 1
    ;;
esac

# 1) Conexión SSH a la aplicación
echo "Conectando a la aplicación $APP_NAME vía SSH..."
cf ssh $APP_NAME <<EOF

# 2) Buscar y eliminar el proceso activo de CDS
echo "Buscando procesos activos del usuario 'vcap' que ejecuten 'node /path_to_cds run'..."
PROCESS_ID=\$(ps aux | grep "node " | grep " /home/vcap/app" | awk '{print \$2}')

if [ -n "\$PROCESS_ID" ]; then
  echo "Matando proceso con ID \$PROCESS_ID..."
  kill -usr1 \$PROCESS_ID
else
  echo "No se encontró ningún proceso que coincida."
fi

# Salir del SSH
exit
EOF

# 4) Redirigir tráfico para debugging
echo "Redirigiendo tráfico al puerto 9229 de tu máquina local..."
cf ssh -N -L 9229:127.0.0.1:9229 $APP_NAME