// Banc de cache OmniRoute — exécuté DANS le conteneur paperclip (node ≥ 18, fetch natif).
// Usage : node banc-cache.mjs '<json des cas>'  → une ligne JSON par appel sur stdout.
// La clé est lue dans process.env.ANTHROPIC_API_KEY et n'est jamais écrite.
import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = process.env.BANC_OMNIROUTE_URL || 'http://localhost:20128';
const KEY = process.env.ANTHROPIC_API_KEY || '';
const cases = JSON.parse(process.argv[2]);
const SKILL = fs.readFileSync(process.env.BANC_SKILL || '/app/skills/paperclip/SKILL.md', 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Blocs construits comme le prompt système réel de l'adaptateur (execute.ts : identité → passation →
// instructions → index des skills → environnement). La passation change à chaque « run ».
function blocks(c, call) {
  const identity = `Vous êtes l'agent Paperclip « Pilote OmniRoute natif (banc) » (banc-${c.id}-${c.nonce}), exécuté via la passerelle OmniRoute.`;
  const handoff = `## Passation de session précédente\n\nRun ${call} (${crypto.randomUUID()}). ` +
    Array.from({ length: 60 }, (_, i) => `Point ${i + 1} du run ${call} : état intermédiaire ${crypto.randomUUID().slice(0, 8)}.`).join(' ');
  const instructions = `## Instructions de l'agent\n\n${SKILL.slice(0, c.stableChars || 36000)}`;
  const skills = '## Skills disponibles\n\n- paperclip : API du board, tickets, documents, commentaires (lire avec read_skill).';
  const env = "## Environnement Paperclip\n\nCes variables sont posées dans l'environnement du shell de cet agent :\n\n```\nPAPERCLIP_API_URL=http://127.0.0.1:3100\n```\n\nVariables propres à ce run : PAPERCLIP_TASK_ID, PAPERCLIP_RUN_ID, PAPERCLIP_WAKE_REASON.";
  const stable = [instructions, skills, env].join('\n\n');
  if (c.ordre === 'identique') return { head: [identity, stable].join('\n\n'), tail: '' };
  // Système identique d'un appel à l'autre ; la partie variable (passation) part dans le message utilisateur.
  if (c.ordre === 'stable-user') return { head: [identity, stable].join('\n\n'), tail: '', user: handoff };
  if (c.ordre === 'actuel') return { head: identity, tail: [handoff, stable].join('\n\n') };
  return { head: [identity, stable].join('\n\n'), tail: handoff }; // stable d'abord
}

function chatBody(c, b, sessionId) {
  const system = b.tail ? `${b.head}\n\n${b.tail}` : b.head;
  let sysMsg = { role: 'system', content: system };
  if (c.cacheControl) {
    // Extension « parts » : point de cache explicite après la partie stable.
    const parts = [{ type: 'text', text: b.head, cache_control: { type: 'ephemeral' } }];
    if (b.tail) parts.push({ type: 'text', text: b.tail });
    sysMsg = { role: 'system', content: parts };
  }
  const body = { model: c.model, max_tokens: 64, stream: false,
    messages: [sysMsg, { role: 'user', content: `${b.user ? `${b.user}\n\n` : ''}Réponds uniquement : OK.` }] };
  if (sessionId) body.user = sessionId;
  return body;
}

function messagesBody(c, b) {
  const system = [{ type: 'text', text: b.head }];
  if (c.cacheControl) system[0].cache_control = { type: 'ephemeral' };
  if (b.tail) system.push({ type: 'text', text: b.tail });
  return { model: c.model, max_tokens: 64, system, messages: [{ role: 'user', content: `${b.user ? `${b.user}\n\n` : ''}Réponds uniquement : OK.` }] };
}

for (const c of cases) {
  c.nonce = crypto.randomUUID().slice(0, 8);
  const sessionId = c.session ? `banc-cache-${c.id}-${c.nonce}` : null;
  for (let call = 1; call <= (c.calls || 3); call += 1) {
    const b = blocks(c, call);
    const isMsg = c.api === 'messages';
    const headers = { 'content-type': 'application/json', 'x-omniroute-no-memory': 'true' };
    if (isMsg) { headers['x-api-key'] = KEY; headers['anthropic-version'] = '2023-06-01'; }
    else headers.authorization = `Bearer ${KEY}`;
    if (sessionId) headers['X-Session-Id'] = sessionId;
    const body = isMsg ? messagesBody(c, b) : chatBody(c, b, sessionId);
    const t0 = Date.now();
    const out = { id: c.id, call, api: c.api, model_demande: c.model, ordre: c.ordre, session: !!c.session,
      cacheControl: !!c.cacheControl, debut: new Date(t0).toISOString(), chars_prompt: JSON.stringify(body).length };
    try {
      const res = await fetch(`${BASE}${isMsg ? '/v1/messages' : '/v1/chat/completions'}`,
        { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const txt = await res.text();
      out.http = res.status;
      out.entetes = Object.fromEntries([...res.headers].filter(([k]) => k.startsWith('x-omniroute') && !/key|token|auth/i.test(k)));
      let j = {};
      try { j = JSON.parse(txt); } catch { out.erreur = txt.slice(0, 200); }
      const u = j.usage || {};
      out.modele_servi = j.model || null;
      out.usage_brut = u;
      out.usage = {
        prompt_tokens: u.prompt_tokens ?? null, input_tokens: u.input_tokens ?? null,
        cached_tokens: u.prompt_tokens_details?.cached_tokens ?? null,
        cache_read_input_tokens: u.cache_read_input_tokens ?? null,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_creation_tokens ?? null,
        creation_in_prompt: u.prompt_tokens_details?.cache_creation_in_prompt ?? null,
        output_tokens: u.completion_tokens ?? u.output_tokens ?? null,
      };
      if (j.error) out.erreur = JSON.stringify(j.error).slice(0, 200);
    } catch (e) {
      out.erreur = String(e).slice(0, 200);
    }
    out.duree_ms = Date.now() - t0;
    process.stdout.write(`${JSON.stringify(out)}\n`);
    await sleep(c.pauseMs ?? 2500);
  }
}
