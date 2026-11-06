// Screens for online play: the "Play online" page, "Connecting", and the room lobby.
import { BOT_KINDS, GAME_LENGTHS, GAME_TITLE, SEAT_KINDS } from './app.ts';
import { PLAYER_COLORS } from './board-view.ts';
import { esc, uiAttr } from './html.ts';
import type { ConnectionStatus } from './online.ts';
import { CODE_LENGTH, MAX_NAME_LENGTH, type BotSpeed, type RoomView } from '../online/protocol.ts';

const kindLabel = (kind: string) => SEAT_KINDS.find((k) => k.kind === kind)?.label ?? kind;

export interface OnlineHomeOptions {
  serverOk: boolean | null; // null = still checking
  name: string;
  code: string;
  message: string | null;
  busy: boolean;
  /** A room this browser was in and can rejoin. */
  savedRoom: string | null;
}

export function renderOnlineHome(o: OnlineHomeOptions): string {
  const back = `<button class="link-btn" ${uiAttr({ cmd: 'goLocal' })}>← Play on this computer instead</button>`;
  const message = o.message ? `<div class="notice">${esc(o.message)}</div>` : '';
  if (o.serverOk === null) {
    return `<div class="setup"><h1>${esc(GAME_TITLE)}</h1><h2>Play online</h2>${message}<p class="muted">Looking for the game server…</p>${back}</div>`;
  }
  if (!o.serverOk) {
    return `
<div class="setup">
  <h1>${esc(GAME_TITLE)}</h1>
  <h2>Play online</h2>
  ${message}
  <p>Online games run on a game server, and this copy of the game isn't connected to one.</p>
  <ul class="muted">
    <li><b>Got an invite link from a friend?</b> Open that link instead.</li>
    <li><b>Want to host?</b> Run the game server on your computer and share its link. See "Playing online" in the README.</li>
  </ul>
  ${back}
</div>`;
  }
  const disabled = o.busy ? ' disabled' : '';
  const rejoin = o.savedRoom
    ? `<div class="notice">You were in room <b>${esc(o.savedRoom)}</b>. <button class="primary" ${uiAttr({ cmd: 'rejoin' })}${disabled}>Rejoin</button> <button class="link-btn" ${uiAttr({ cmd: 'forgetRoom' })}>Forget it</button></div>`
    : '';
  return `
<div class="setup">
  <h1>${esc(GAME_TITLE)}</h1>
  <h2>Play online</h2>
  ${message}${rejoin}
  <label class="opt">Your name <input id="online-name" class="name" maxlength="${MAX_NAME_LENGTH}" value="${esc(o.name)}" autocomplete="nickname"></label>
  <div class="online-choices">
    <section>
      <h3>Start a room</h3>
      <p class="muted small">You'll get a link to send to friends. Empty seats can be filled with bots.</p>
      <button class="primary" ${uiAttr({ cmd: 'createRoom' })}${disabled}>Create a room</button>
    </section>
    <section>
      <h3>Join a friend</h3>
      <p class="muted small">Enter the room code they sent you.</p>
      <input id="online-code" class="code-input" maxlength="${CODE_LENGTH}" value="${esc(o.code)}" placeholder="ABCDE" autocomplete="off" spellcheck="false">
      <button class="primary" ${uiAttr({ cmd: 'joinRoom' })}${disabled}>Join</button>
    </section>
  </div>
  ${o.busy ? '<p class="muted">Talking to the server…</p>' : ''}
  ${back}
</div>`;
}

export function renderConnecting(status: ConnectionStatus): string {
  const text = status === 'reconnecting' ? "Can't reach the server. Trying again…" : 'Connecting to the room…';
  return `<div class="setup"><h1>${esc(GAME_TITLE)}</h1><p>${text}</p><button ${uiAttr({ cmd: 'exitGame' })}>Cancel</button></div>`;
}

export interface LobbyOptions {
  inviteUrl: string;
  status: ConnectionStatus;
  copied: boolean;
  error: string | null;
}

const SPEED_LABELS: Record<BotSpeed, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

export function renderLobby(view: RoomView, o: LobbyOptions): string {
  const isHost = view.you === view.hostSeat;
  const seats = view.seats
    .map((seat, i) => {
      const tags = [
        i === view.hostSeat ? '<span class="badge">host</span>' : '',
        i === view.you ? '<span class="badge you">you</span>' : '',
        seat.kind === 'human' && !seat.connected ? '<span class="badge offline">offline</span>' : '',
      ].join('');
      const remove = isHost && i !== view.you ? `<button class="link-btn" ${uiAttr({ cmd: 'removeSeat', seat: i })}>Remove</button>` : '';
      return `<li class="seat"><span class="dot" style="background:${PLAYER_COLORS[i]}">${i + 1}</span><b>${esc(seat.name)}</b> <span class="muted small">${esc(kindLabel(seat.kind))}</span>${tags}<span class="spacer"></span>${remove}</li>`;
    })
    .join('');
  const empty = Array.from({ length: 4 - view.seats.length }, () => '<li class="seat empty muted">Empty seat: waiting for a player…</li>').join('');
  const addBot =
    isHost && view.seats.length < 4
      ? `<div class="add-bot"><select id="bot-kind" aria-label="Bot type">${BOT_KINDS.map((k) => `<option value="${k}">${esc(kindLabel(k))}</option>`).join('')}</select> <button ${uiAttr({ cmd: 'addBot' })}>Add a bot</button></div>`
      : '';
  const op = view.options;
  const options = isHost
    ? `
  <label class="opt">Game length <select data-room-option="target">${GAME_LENGTHS.map((l) => `<option value="${l.target}"${l.target === op.target ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select></label>
  <label class="opt">Bot speed <select data-room-option="botSpeed">${(Object.keys(SPEED_LABELS) as BotSpeed[]).map((s) => `<option value="${s}"${s === op.botSpeed ? ' selected' : ''}>${SPEED_LABELS[s]}</option>`).join('')}</select></label>
  <label class="opt"><input type="checkbox" data-room-option="randomOrder"${op.randomOrder ? ' checked' : ''}> Random turn order</label>
  <label class="opt"><input type="checkbox" data-room-option="catchUpCash"${op.catchUpCash ? ' checked' : ''}> Catch-up cash: each later player starts with +125G</label>
  <label class="opt"><input type="checkbox" data-room-option="ventureCards"${op.ventureCards ? ' checked' : ''}> Venture cards</label>`
    : `<p class="muted">Target ${op.target.toLocaleString('en-US')}G · ${op.randomOrder ? 'random turn order' : 'seats in order'} · catch-up cash ${op.catchUpCash ? 'on' : 'off'} · venture cards ${op.ventureCards ? 'on' : 'off'} · bots ${SPEED_LABELS[op.botSpeed].toLowerCase()}</p>`;
  const start = isHost
    ? `<button class="primary big" ${uiAttr({ cmd: 'startOnline' })}${view.seats.length < 2 ? ' disabled' : ''}>Start game</button>${view.seats.length < 2 ? '<p class="muted small">Invite a friend or add a bot first.</p>' : ''}`
    : '<p class="waiting">Waiting for the host to start the game…</p>';
  const status = o.status === 'reconnecting' ? '<div class="notice">Connection lost. Reconnecting…</div>' : '';
  const error = o.error ? `<div class="error">${esc(o.error)} <button class="link-btn" ${uiAttr({ cmd: 'dismissError' })}>OK</button></div>` : '';
  return `
<div class="setup lobby">
  <h1>${esc(GAME_TITLE)}</h1>
  ${status}${error}
  <div class="room-code">Room code <b>${esc(view.code)}</b></div>
  <div class="invite">
    <input id="invite-link" readonly value="${esc(o.inviteUrl)}" aria-label="Invite link">
    <button ${uiAttr({ cmd: 'copyInvite' })}>${o.copied ? 'Copied!' : 'Copy invite link'}</button>
  </div>
  <h2>Players</h2>
  <ul class="seat-list">${seats}${empty}</ul>
  ${addBot}
  <p class="muted small">${op.randomOrder ? 'Turn order is shuffled when the game starts.' : 'Players go in the order shown.'}</p>
  <h2>Options</h2>
  ${options}
  ${start}
  <p><button class="link-btn" ${uiAttr({ cmd: 'leaveRoom' })}>Leave room</button></p>
</div>`;
}