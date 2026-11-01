export class ConversationStore {
  constructor({ maxMessages = 20 } = {}) {
    this.conversations = new Map();
    this.maxMessages = Math.max(2, Number(maxMessages) || 20);
  }

  get(userId) {
    return this.conversations.get(userId) || [];
  }

  append(userId, ...messages) {
    const history = this.conversations.get(userId) || [];
    history.push(...messages);
    if (history.length > this.maxMessages) history.splice(0, history.length - this.maxMessages);
    this.conversations.set(userId, history);
  }

  clear(userId) {
    this.conversations.delete(userId);
  }

  removeLast(userId, message) {
    const history = this.conversations.get(userId);
    if (history?.at(-1) === message) history.pop();
  }
}
