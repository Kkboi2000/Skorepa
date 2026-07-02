/* ============================================================
   Skore Party — net.js
   Every Supabase call lives here. app.js never touches `sb`
   directly, so the whole sync layer is swappable/testable.

   Design rule: the target angle NEVER leaves the host's browser
   until reveal(). Deploy publishes only words + phase, so guests
   cannot cheat by inspecting traffic or the database.
   ============================================================ */
import { sb } from './config.js';

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

export function watchRoom(code, { onRoom, onPlayers }) {
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
    .subscribe();

  refetchRoom();
  refetchPlayers();
  return () => sb.removeChannel(ch);
}

/* ---------------- host actions ---------------- */

export const startGame = code =>
  sb.from('rooms').update({ phase: 'prep' }).eq('code', code);

export async function deploy(code, leftWord, rightWord, mode) {
  // reset every guess from the previous round, then open aiming.
  // NOTE: target_angle stays null — the secret lives in the host's memory.
  await sb.from('players')
    .update({ locked: false, needle: null }).eq('room_code', code);
  await sb.from('rooms').update({
    phase: 'aiming', mode,
    left_word: leftWord, right_word: rightWord,
    target_angle: null
  }).eq('code', code);
}

/* Band geometry: bands are 9° wide, values [2,3,4,3,2] centered
   on the target → |diff| ≤ 4.5 = 4pts, ≤ 13.5 = 3, ≤ 22.5 = 2. */
export function scoreFor(needle, target) {
  if (needle == null || target == null) return 0;
  const d = Math.abs(needle - target);
  return d <= 4.5 ? 4 : d <= 13.5 ? 3 : d <= 22.5 ? 2 : 0;
}

export async function reveal(code, targetAngle, guests) {
  await Promise.all(guests.map(g =>
    sb.from('players')
      .update({ score: g.score + scoreFor(g.needle, targetAngle) })
      .eq('id', g.id)));
  await sb.from('rooms')
    .update({ phase: 'revealed', target_angle: targetAngle })
    .eq('code', code);
}

export const continueRound = (code, round) =>
  sb.from('rooms').update({
    phase: 'prep', target_angle: null,
    left_word: null, right_word: null,
    round: round + 1
  }).eq('code', code);

export const backToLobby = code =>
  sb.from('rooms').update({
    phase: 'lobby', target_angle: null,
    left_word: null, right_word: null,
    pending_host: null
  }).eq('code', code);

export const deleteRoom = code =>
  sb.from('rooms').delete().eq('code', code); // cascades to players

/* ---------------- switch host ---------------- */

export const offerHost = (code, playerId) =>
  sb.from('rooms').update({ pending_host: playerId }).eq('code', code);

export const declineHost = code =>
  sb.from('rooms').update({ pending_host: null }).eq('code', code);

export async function acceptHost(code, myId, oldHostId) {
  await sb.from('players').update({ is_host: false }).eq('id', oldHostId);
  await sb.from('players').update({ is_host: true }).eq('id', myId);
  await sb.from('rooms').update({
    host_id: myId, pending_host: null,
    phase: 'prep', target_angle: null,
    left_word: null, right_word: null
  }).eq('code', code);
}

/* ---------------- guest actions ---------------- */

export const lockAnswer = (playerId, needle) =>
  sb.from('players').update({ needle, locked: true }).eq('id', playerId);

export const leaveRoom = playerId =>
  sb.from('players').delete().eq('id', playerId);
