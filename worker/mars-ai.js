// Mission to Mars tracker: AI helper (Cloudflare Worker, Workers AI)
//
// Paste this whole file into the Cloudflare dashboard editor for your Worker.
// Settings needed on the Worker (Settings → Bindings / Variables):
//   AI              Workers AI binding (Bindings → Add → Workers AI, name it AI)
//   SUPABASE_URL    https://vauwzrrtboitxzctdxqm.supabase.co
//   SUPABASE_KEY    your Supabase publishable key (the same one the tracker uses; safe to share)
//   ALLOWED_EMAILS  the email you sign in to the tracker with (comma-separate several)
// Optional:
//   MODEL           defaults to @cf/qwen/qwen3-30b-a3b-fp8
//   ALLOWED_ORIGINS defaults to https://imheet07-gif.github.io
//
// Only signed-in tracker users on ALLOWED_EMAILS can use it, so nobody else can spend your free daily allowance.
// On Cloudflare's Free plan, usage simply stops when the daily allowance is used up; there is nothing to bill.

const DEFAULT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

const SYSTEM = `You are a patient tutor helping an adult learn rocket science from scratch. \
They have a finance background and no physics training. \
Write in plain English: short paragraphs or a few "- " bullet points, under 180 words unless asked for more. \
Define any technical term the first time you use it. \
Use an everyday or finance analogy only when it genuinely makes the idea clearer. \
Base your answer on the text you are given; if it doesn't cover something, say so briefly rather than guessing. \
Write maths in plain text (for example F = m × a), and only when it helps. No headings, no tables.`;

const TASKS = {
  summarise: b => `Summarise this page from my reading in 4 to 6 "- " bullet points, \
then add one sentence on why it matters for understanding rocket engines.\n\nPage: ${b.title}\n\n${b.text}`,
  explain: b => `Explain the highlighted passage simply, then give one short concrete example.\n\nFrom: ${b.title}\n\
Highlighted: ${b.text}${b.context ? `\nThe text around it, for context: ${b.context}` : ""}`,
  answer: b => `My question: ${b.question}\n\nPassages from my reading that may help (they can be partial):\n${b.text}\n\n\
Answer my question directly in plain language. If the passages don't cover it, answer from general knowledge \
but say that it isn't in my reading.`,
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const origins = (env.ALLOWED_ORIGINS || "https://imheet07-gif.github.io").split(",").map(s => s.trim());
    const cors = {
      "Access-Control-Allow-Origin": origins.includes(origin) ? origin : origins[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return reply({ error: "This address only answers the Mars tracker." }, 405);

    // Who is asking: check the tracker sign-in with Supabase
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return reply({ error: "Sign in under Flight systems to use ✨." }, 401);
    const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` } });
    if (!who.ok) return reply({ error: "Your sign-in has expired. Sign in again under Flight systems." }, 401);
    const user = await who.json();
    const allowed = (env.ALLOWED_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.length || !allowed.includes(String(user.email || "").toLowerCase())) {
      return reply({ error: "This account isn’t set up to use ✨ AI." }, 403);
    }

    let body;
    try { body = await request.json(); } catch { return reply({ error: "Bad request." }, 400); }
    const task = TASKS[body.task];
    if (!task) return reply({ error: "Unknown request." }, 400);
    const b = {
      title: String(body.title || "").slice(0, 200),
      text: String(body.text || "").slice(0, 12000),
      question: String(body.question || "").slice(0, 500),
      context: String(body.context || "").slice(0, 3000),
    };

    const model = env.MODEL || DEFAULT_MODEL;
    try {
      const out = await env.AI.run(model, {
        // "/no_think" turns off Qwen3's long hidden reasoning, which would only use up the allowance
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: task(b) + "\n/no_think" }],
        max_tokens: 700,
        temperature: 0.3,
      });
      let text = out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content));
      if (typeof text !== "string") text = text == null ? "" : JSON.stringify(text);
      text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!text) return reply({ error: "The AI gave an empty answer. Try again." }, 502);
      return reply({ text, model });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/limit|quota|neuron|exceed|4006|3036/i.test(msg)) {
        return reply({ error: "Today’s free AI allowance is used up. It resets at midnight UTC." }, 429);
      }
      return reply({ error: "The AI didn’t respond. Try again in a moment." }, 502);
    }
  },
};
