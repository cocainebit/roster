// Used by tests and by a deployment with no model credential at all. It answers in a way a test can
// predict, and it counts tokens like a provider that reports usage.
export class FakeProvider {
  constructor({ reply = 'done', inputTokens = 50, outputTokens = 20, fail = false, replies = null } = {}) {
    Object.assign(this, { reply, inputTokens, outputTokens, fail, replies });
    this.calls = [];
  }

  async chat({ model, system, messages, maxOutputTokens }) {
    this.calls.push({ model, system, messages, maxOutputTokens });
    if (this.fail) throw Object.assign(new Error('the model provider is down (test)'), { code: 'provider_failed' });
    const scripted = this.replies ? this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)] : null;
    const text = typeof scripted === 'function' ? scripted({ messages, system }) : (scripted ?? this.reply);
    return {
      text,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens, counted: 'provider' },
      finishReason: 'stop',
    };
  }
}
