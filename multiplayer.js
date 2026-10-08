export class MultiplayerClient {
  constructor({ onState, onOpponentTell, onDisconnect }) {
    this.onState = onState;
    this.onOpponentTell = onOpponentTell;
    this.onDisconnect = onDisconnect;
    this.socket = null;
    this.pending = new Map();
    this.sequence = 0;
    this.closedIntentionally = false;
    this.closedByServer = false;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.closedIntentionally = false;
    this.connecting = new Promise((resolve, reject) => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      this.socket = socket;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("サーバーに接続できません。")), { once: true });
      socket.addEventListener("message", (event) => this.handleMessage(event));
      socket.addEventListener("close", () => this.handleClose());
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async request(type, fields = {}) {
    await this.connect();
    const requestId = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("サーバーから応答がありません。接続を確認してください。"));
      }, 10000);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ type, ...fields, requestId }));
    });
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      this.onDisconnect?.("サーバーから不正なデータを受信しました。");
      this.socket.close();
      return;
    }
    if (message.type === "state") this.onState?.(message);
    if (message.type === "opponentTell") this.onOpponentTell?.();
    if (message.type === "roomClosed") {
      this.closedByServer = true;
      sessionStorage.removeItem("pokerOnlineSession");
      this.onDisconnect?.(message.message);
    }
    if (message.type === "session") {
      sessionStorage.setItem("pokerOnlineSession", JSON.stringify({
        roomCode: message.roomCode,
        token: message.token,
        name: message.name,
      }));
    }
    if (message.requestId && this.pending.has(message.requestId)) {
      const pending = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      window.clearTimeout(pending.timeout);
      if (message.type === "error") pending.reject(new Error(message.message));
      else pending.resolve(message.result ?? message);
    }
  }

  handleClose() {
    this.socket = null;
    this.pending.forEach(({ reject, timeout }) => {
      window.clearTimeout(timeout);
      reject(new Error("サーバーとの接続が切れました。"));
    });
    this.pending.clear();
    if (!this.closedIntentionally && !this.closedByServer) {
      this.onDisconnect?.("接続が切れました。ページを再読み込みすると再接続できます。");
    }
  }

  close() {
    this.closedIntentionally = true;
    sessionStorage.removeItem("pokerOnlineSession");
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "leave" }));
    this.socket?.close(1000, "Player left");
    this.socket = null;
  }
}
