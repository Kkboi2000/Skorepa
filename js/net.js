/* ============================================================
   Skore Party — net.js
   Every Supabase call lives here. app.js never touches `sb`
   directly, so the whole sync layer is swappable/testable.

   Design rule: the target angle NEVER leaves the host's browser
   until reveal(). Deploy publishes only words + phase, so guests
   cannot cheat by inspecting traffic or the database.
   ============================================================ */
import { sb } from './config.js';

/* Supabase query builders are LAZY: the HTTP request is only sent
   when the builder is awaited (its .then() runs the fetch). Any
   query returned to a caller that drops the promise never executes.
   `run` forces execution and surfaces errors, so every export below
   is safe to fire-and-forget. */
async function run(query) {
  const { error } = await query;
  if (error) throw error;
}

/* The active room channel, kept so setTopic can also BROADCAST the topic
   live (belt-and-suspenders alongside the DB write, and the only transport
   if the optional `topic` column hasn't been added yet). */
let topicChannel = null;

/* ---------------- title screen ---------------- */

export async function createRoom(name) {
  // retry on the (rare) 5-digit code collision
  for (let tries = 0; tries < 6; tries++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const hostId = crypto.randomUUID();
    const { error } = await sb.from('rooms').insert({ code, host_id: hostId });
    if (error) continue;
    const { error: pe } = await sb.from('players')
      .insert({ id: hostId, room_code: code, name, is_host: true });
    if (pe) throw pe;
    return { code, playerId: hostId };
  }
  throw new Error('Could not create a room. Please try again.');
}

export async function joinRoom(code, name) {
  const { data: room, error } = await sb.from('rooms')
    .select().eq('code', code).maybeSingle();
  if (error) throw error;
  if (!room) throw new Error('Room not found. Check the code.');
  const { data: me, error: pe } = await sb.from('players')
    .insert({ room_code: code, name }).select().single();
  if (pe) throw pe;
  return { room, playerId: me.id };
}

export async function fetchPlayer(playerId) {
  const { data } = await sb.from('players')
    .select().eq('id', playerId).maybeSingle();
  return data ?? null;
}

/* ---------------- live sync ---------------- */
/* One channel powers every screen. Player DELETE events don't
   carry the room_code filter column reliably, so the players
   subscription is unfiltered and we simply refetch our room's
   roster on any change — cheap and always correct. */

export function watchRoom(code, { onRoom, onPlayers, onTopic }) {
  const refetchPlayers = async () => {
    const { data } = await sb.from('players')
      .select().eq('room_code', code).order('joined_at');
    if (data) onPlayers(data);
  };
  const refetchRoom = async () => {
    const { data } = await sb.from('rooms')
      .select().eq('code', code).maybeSingle();
    onRoom(data ?? null);
  };

  const ch = sb.channel(`room-${code}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'rooms', filter: `code=eq.${code}` },
      p => { if (p.eventType === 'DELETE') onRoom(null); else onRoom(p.new); })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'players' },
      refetchPlayers)
    .on('broadcast', { event: 'topic' },
      ({ payload }) => { if (onTopic) onTopic(payload ? payload.topic : null); })
    .subscribe();

  topicChannel = ch;
  refetchRoom();
  refetchPlayers();
  return () => { if (topicChannel === ch) topicChannel = null; sb.removeChannel(ch); };
}

/* Live topic mirror — instant, migration-independent. Guests fall back to
   this when the `topic` column is absent. Fire-and-forget. */
export function broadcastTopic(topic) {
  if (!topicChannel) return;
  try { topicChannel.send({ type: 'broadcast', event: 'topic', payload: { topic } }); }
  catch { /* channel not ready — ignore */ }
}

/* ---------------- host actions ---------------- */

export const startGame = code =>
  run(sb.from('rooms').update({ phase: 'prep' }).eq('code', code));

export async function deploy(code, leftWord, rightWord, mode) {
  // reset every guess from the previous round, then open aiming.
  // NOTE: target_angle stays null — the secret lives in the host's memory.
  await run(sb.from('players')
    .update({ locked: false, needle: null }).eq('room_code', code));
  await run(sb.from('rooms').update({
    phase: 'aiming', mode,
    left_word: leftWord, right_word: rightWord,
    target_angle: null
  }).eq('code', code));
}

/* The shared "topic to rate" the host types instead of saying it out
   loud. Kept OUT of the core room writes so a missing `topic` column
   only ever affects this one feature — never blocks starting a game,
   deploying, or continuing. Requires a one-time migration:
     alter table public.rooms add column if not exists topic text;
   `topic === null` → box removed;  '' → present but empty;  text → shown. */
export const setTopic = (code, topic) =>
  run(sb.from('rooms').update({ topic }).eq('code', code));

/* Band geometry: bands are 9° wide, values [1,2,3,2,1] centered
   on the target → |diff| ≤ 4.5 = 3pts, ≤ 13.5 = 2, ≤ 22.5 = 1. */
export function scoreFor(needle, target) {
  if (needle == null || target == null) return 0;
  const d = Math.abs(needle - target);
  return d <= 4.5 ? 3 : d <= 13.5 ? 2 : d <= 22.5 ? 1 : 0;
}

export async function reveal(code, targetAngle, guests) {
  await Promise.all(guests.map(g =>
    run(sb.from('players')
      .update({ score: g.score + scoreFor(g.needle, targetAngle) })
      .eq('id', g.id))));
  await run(sb.from('rooms')
    .update({ phase: 'revealed', target_angle: targetAngle })
    .eq('code', code));
}

export const continueRound = (code, round) =>
  run(sb.from('rooms').update({
    phase: 'prep', target_angle: null,
    left_word: null, right_word: null,
    round: round + 1
  }).eq('code', code));

export const backToLobby = code =>
  run(sb.from('rooms').update({
    phase: 'lobby', target_angle: null,
    left_word: null, right_word: null,
    pending_host: null
  }).eq('code', code));

export const deleteRoom = code =>
  run(sb.from('rooms').delete().eq('code', code)); // cascades to players

/* ---------------- switch host ---------------- */

export const offerHost = (code, playerId) =>
  run(sb.from('rooms').update({ pending_host: playerId }).eq('code', code));

export const declineHost = code =>
  run(sb.from('rooms').update({ pending_host: null }).eq('code', code));

export async function acceptHost(code, myId, oldHostId) {
  await run(sb.from('players').update({ is_host: false }).eq('id', oldHostId));
  await run(sb.from('players').update({ is_host: true }).eq('id', myId));
  await run(sb.from('rooms').update({
    host_id: myId, pending_host: null,
    phase: 'prep', target_angle: null,
    left_word: null, right_word: null
  }).eq('code', code));
}

/* ---------------- guest actions ---------------- */

export const lockAnswer = (playerId, needle) =>
  run(sb.from('players').update({ needle, locked: true }).eq('id', playerId));

export const leaveRoom = playerId =>
  run(sb.from('players').delete().eq('id', playerId));
