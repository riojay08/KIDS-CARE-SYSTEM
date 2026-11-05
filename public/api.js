const api = {
  token: localStorage.getItem('kc_token'),
  setToken(t) {
    this.token = t;
    t ? localStorage.setItem('kc_token', t) : localStorage.removeItem('kc_token');
  },
  async req(path, opts = {}) {
    const isForm = opts.body instanceof FormData;
    const headers = {};
    if (!isForm) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body && !isForm ? JSON.stringify(opts.body) : opts.body
    });
    
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'May error, subukan ulit');
    return data;
  }
};