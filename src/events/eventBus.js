const listeners = new Map();

const eventBus = {
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
  },

  emit(event, data) {
    const handlers = listeners.get(event) || [];
    for (const handler of handlers) {
      handler(data);
    }
  },
};

module.exports = { eventBus };
