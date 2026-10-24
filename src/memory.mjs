export class ConversationStore {
  constructor(limit = 12, maxUsers = 1000) {
    this.limit = limit;
    this.maxUsers = maxUsers;
    this.conversations = new Map();
  }

  get(userId) {
    return [...(this.conversations.get(userId) || [])];
  }

  append(userId, ...messages) {
    const history = this.conversations.get(userId) || [];
    history.push(...messages);
    while (history.length > this.limit) history.shift();
    this.conversations.delete(userId);
    this.conversations.set(userId, history);

    while (this.conversations.size > this.maxUsers) {
      this.conversations.delete(this.conversations.keys().next().value);
    }
  }

  clear(userId) {
    this.conversations.delete(userId);
  }
}
