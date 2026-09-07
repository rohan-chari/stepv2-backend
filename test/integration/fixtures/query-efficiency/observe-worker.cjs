// Observability only: start the unchanged production entrypoint normally.
// This does not invoke, replace, or stub any business-logic function.
const { prisma } = require('../../../../src/db');
prisma.$on('query', event => {
  if (process.send && (event.query.includes('global_step_event_entitlements') ||
      event.query.includes('enrollment_candidates'))) {
    process.send({kind:'query',query:event.query,params:event.params});
  }
});
