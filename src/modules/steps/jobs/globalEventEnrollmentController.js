const { GlobalStepEvent } = require('../models/globalStepEvent');
const { discoverEnrollmentPages } = require('../models/globalStepEventEntitlement');
const { writeEnrollmentCandidates } = require('../services/globalStepEventEntitlement');
const { coordinatedOptimizationMetrics: metrics } = require('../../../shared/observability/coordinatedOptimizationMetrics');
const PAGE_SIZE = 8;
function lane() { return { active: false, parents: [], cursor: null, terminalPage: false, startedAt: 0 }; }
function reset(value) { Object.assign(value, lane(), { active: true, startedAt: Date.now() }); }
const sameCursor = (left, right) => left?.id === right?.id && String(left?.startsAt) === String(right?.startsAt);
function createGlobalEventEnrollmentController(dependencies = {}) {
  const model = dependencies.GlobalStepEvent || GlobalStepEvent;
  const discover = dependencies.discoverEnrollmentPages || discoverEnrollmentPages;
  const write = dependencies.writeEnrollmentCandidates || writeEnrollmentCandidates;
  const legacyMaterialize = dependencies.materializeEntitlementsForActiveRacers;
  const now = dependencies.now || (() => new Date());
  const budgetMs = Math.max(1, Number(dependencies.materializationTickBudgetMs) || 5000);
  const head = lane(), tail = lane();
  let nextLane = 'head';
  let headAgain = false;
  let fallbackParents = null;
  const requestedParents = [];
  const stopped = (options) => options.isStopped?.() === true;
  function requestHead({ parents = null } = {}) {
    if (parents) fallbackParents = parents.slice(0, PAGE_SIZE);
    if (!head.active) reset(head); else {
      headAgain = true;
      metrics.increment('global_event_enrollment_total', { outcome: 'pending_minute_request' });
    }
    if (!tail.active) reset(tail);
  }
  function addParent(event) {
    // Used only by old injected models without paginated discovery; production
    // parents are always discovered from the bounded source-of-truth query.
    if (!event) return;
    if (legacyMaterialize) { fallbackParents = [event]; requestedParents.length = 0; }
    if (!head.active) reset(head);
    if (!tail.active) reset(tail);
    if (!legacyMaterialize && typeof model.findLocalParentsForMaintenance !== 'function' && requestedParents.length < 2) requestedParents.push(event);
  }
  async function loadPage(current) {
    if (!current.active || current.parents.length) return;
    let events;
    if (fallbackParents) {
      events = current.cursor ? [] : [...fallbackParents, ...requestedParents].slice(0, PAGE_SIZE);
    } else {
      events = typeof model.findLocalParentsForMaintenance === 'function'
        ? await model.findLocalParentsForMaintenance(now(), { after: current.cursor, take: PAGE_SIZE }) : requestedParents;
    }
    current.parents = (events || []).map(event => ({ event, afterUserId: null, done: false, lastServiceAt: null }));
    current.terminalPage = current.parents.length < PAGE_SIZE;
    if (!current.parents.length) completePage(current);
  }
  function completePage(current) {
    const last = current.parents.at(-1)?.event;
    if (last) current.cursor = { startsAt: last.startsAt, id: last.id };
    current.parents = [];
    if (current.terminalPage || !last) {
      current.active = false;
      if (current === head && headAgain) { headAgain = false; reset(head); }
    }
  }
  async function round(current, other, options, admitted) {
    await loadPage(current);
    if (!current.active || !current.parents.length || stopped(options) || !admitted()) return;
    // Seed the matching tail page from the head's actual observation. Matching
    // resident pages share discoveries and successful writes in either direction.
    if (other.active && !other.parents.length && sameCursor(current.cursor, other.cursor)) {
      other.parents = current.parents.map(entry => ({ ...entry }));
      other.terminalPage = current.terminalPage;
    }
    const entries = current.parents.filter(entry => !entry.done);
    const pages = legacyMaterialize ? null : await discover(entries.map(entry => ({
      eventId: entry.event.id, afterUserId: entry.afterUserId,
    })));
    for (let index = 0; index < entries.length; index++) {
      if (stopped(options) || !admitted()) return;
      const entry = entries[index];
      const page = pages?.[index];
      if (pages && (!page || page.eventId !== entry.event.id)) throw new Error('enrollment page mismatch');
      const optionsForWrite = { now: now(), batchSize: 500, afterUserId: entry.afterUserId, returnPage: true,
        afterDiscovery: dependencies.materializationAfterDiscovery, decisionNow: now, shouldWrite: () => !stopped(options) && admitted() };
      const result = legacyMaterialize
        ? await legacyMaterialize(entry.event, optionsForWrite)
        : await write(entry.event, page.candidates, optionsForWrite);
      if (result?.interrupted) return;
      // Numeric legacy doubles expose only created counts, never production SQL.
      const normalized = typeof result === 'number'
        ? { exhausted: result !== 500, nextCursor: entry.afterUserId } : result;
      if (normalized && !normalized.exhausted && typeof result !== 'number' &&
          (!normalized.nextCursor || normalized.nextCursor === entry.afterUserId)) {
        throw new Error('enrollment candidate cursor did not advance');
      }
      const peer = other.parents.find(value => !value.done && value.event.id === entry.event.id && value.afterUserId === entry.afterUserId);
      for (const [owner, value] of [[current, entry], ...(peer ? [[other, peer]] : [])]) {
        const stamp = Date.now();
        if (value.lastServiceAt != null) metrics.observe('global_event_enrollment_seconds', (stamp - value.lastServiceAt) / 1000, { kind: 'parent_service_gap' });
        value.lastServiceAt = stamp;
        value.done = owner === head || !normalized || normalized.exhausted;
        value.afterUserId = normalized?.nextCursor ?? value.afterUserId;
      }
    }
    if (current.parents.length && current.parents.every(entry => entry.done)) completePage(current);
    if (other.parents.length && other.parents.every(entry => entry.done)) completePage(other);
  }
  async function runEnrollmentSlice(options = {}) {
    const started = Date.now();
    const admitted = () => Date.now() - started < budgetMs;
    try {
      while (!stopped(options) && admitted() && (head.active || tail.active)) {
        const current = nextLane === 'head' ? head : tail;
        const other = current === head ? tail : head;
        nextLane = current === head ? 'tail' : 'head';
        if (!current.active) continue;
        await round(current, other, options, admitted);
      }
    } finally {
      const elapsed = Date.now() - started;
      metrics.observe('global_event_enrollment_seconds', elapsed / 1000, { kind: 'slice' });
      metrics.observe('global_event_enrollment_seconds', budgetMs / 1000, { kind: 'admission_budget' });
      if (elapsed > budgetMs) metrics.increment('global_event_enrollment_total', { outcome: 'slice_overrun' });
      for (const [kind, value] of [['head_age', head], ['tail_age', tail]]) {
        if (value.active) metrics.observe('global_event_enrollment_seconds', (Date.now() - value.startedAt) / 1000, { kind });
      }
    }
    return { more: !stopped(options) && (head.active || tail.active), retryAfterMs: 250 };
  }
  return { requestHead, addParent, runEnrollmentSlice,
    snapshot: () => ({ head: { active: head.active, parents: head.parents.length }, tail: { active: tail.active, parents: tail.parents.length } }) };
}
module.exports = { createGlobalEventEnrollmentController };
