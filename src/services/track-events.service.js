// One queue per Track; never acquire another Track queue inside an operation.
function createCoordinator() {
  const tails = new Map();
  return {
    run(key, operation) {
      key = String(key).toLowerCase();
      const result = (tails.get(key) || Promise.resolve()).then(operation);
      const tail = result.catch(() => {}).finally(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      tails.set(key, tail);
      return result;
    },
    async idle() { await Promise.all([...tails.values()]); },
    get size() { return tails.size; },
  };
}

const coordinator = createCoordinator();
let publisher;

function bindPublisher(handler) {
  if (publisher) throw new Error('A Track realtime publisher is already attached.');
  publisher = handler;
  return () => { if (publisher === handler) publisher = undefined; };
}

// Call only AFTER the transaction promise resolves, inside the Track queue.
// A notification failure cannot turn an already committed mutation into a 500.
async function afterCommit(event, trackId, data) {
  try {
    await publisher?.(event, String(trackId).toLowerCase(), data);
  } catch (error) {
    console.error('Track realtime notification failed after commit.', {
      event, errorName: error?.name || 'Error',
    });
  }
}

module.exports = { createCoordinator, coordinator, bindPublisher, afterCommit };
