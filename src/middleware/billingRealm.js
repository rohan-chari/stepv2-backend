const { prisma: defaultPrisma } = require('../db');

// Friendly HTTP conflicts. Database admission triggers are the authoritative
// backstop for worker paths, stale auth-cache snapshots and concurrent changes.
function buildBillingRealmGuard(kind, db = defaultPrisma) {
  return async (req, res, next) => {
    if (!req.user || !['production','sandbox'].includes(req.user.billingRealm)) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const conflict = () => res.status(409).json({error:'Sandbox accounts can only participate with other sandbox accounts.',code:'BILLING_REALM_MISMATCH'});
    try {
      if (req.user.billingRealm === 'sandbox' && req.path.startsWith('/seeded/')) return conflict();
      const id = req.path.split('/')[1];
      if (!/^[0-9a-f-]{36}$/i.test(id || '')) return next();
      const target = await db[kind].findUnique({where:{id},select:{economicRealm:true}});
      if (!target) return next();
      const actor = await db.user.findUnique({where:{id:req.user.id},select:{billingRealm:true}});
      if (actor && actor.billingRealm !== target.economicRealm) return conflict();
      const invitees = req.body?.inviteeIds;
      if (Array.isArray(invitees) && invitees.every(id => typeof id === 'string')) {
        const users = await db.user.findMany({where:{id:{in:invitees}},select:{billingRealm:true}});
        if (users.some(user => user.billingRealm !== target.economicRealm)) return conflict();
      }
      return next();
    } catch (error) { return next(error); }
  };
}
module.exports = { buildBillingRealmGuard };
