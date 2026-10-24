export class ConversationStore {
  constructor() {
    this.conversations = new Map();
  }

  get(userId) {
    return [...(this.conversations.get(userId) || [])];
  }

  append(userId, ...messages) {
    const history = this.conversations.get(userId) || [];
    history.push(...messages);
    this.conversations.set(userId, history);
  }

  clear(userId) {
    this.conversations.delete(userId);
  }
}
