// Worker programado: renovación de tokens de AliExpress y avisos de reautorización.
// Solo tiene handler "scheduled": no expone ninguna URL ni endpoint de administración.
import { runTokenMaintenance } from "../../../lib/token-maintenance.mjs";

export default {
  async scheduled(controller, env) {
    try {
      await runTokenMaintenance(env, { now: controller.scheduledTime });
    } catch (err) {
      // Solo nombre y mensaje del error: refreshAccount nunca incluye tokens en sus errores.
      console.error(`AliExpress token-refresh: ejecución fallida: ${err.name}: ${err.message}`);
      throw err;
    }
  },
};
