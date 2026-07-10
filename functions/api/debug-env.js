export async function onRequestGet({ env }) {
  const keys = Object.keys(env || {}).sort();
  const hasMolit = Boolean(env?.MOLIT_SERVICE_KEY);
  const molitLength = hasMolit ? String(env.MOLIT_SERVICE_KEY).length : 0;

  return new Response(
    JSON.stringify({
      hasMolit,
      molitLength,
      keys,
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}
