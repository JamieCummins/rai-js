/** Error codes shared by all backends; the screens map them to messages (strings.errors). */
export class BackendError extends Error {
  constructor(code, message, data) {
    super(message || code);
    this.code = code; // 'study' | 'email' | 'code' | 'invalid' | 'identifier' | 'notInvited' | 'tooMany' | 'emailUnavailable' | 'emailFailed' | 'completed' | 'network' | 'unauthorized' | 'server'
    this.data = data || null; // the server's JSON body, when there was one
  }
}
