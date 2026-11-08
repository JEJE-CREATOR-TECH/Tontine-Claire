/* Tontine Claire — version 1
   Les données de chaque tontine sont stockées dans Supabase (serveurs en Europe).
   Chaque membre ne voit que ses tontines ; les règles de sécurité sont dans supabase/schema.sql. */
(function(){
'use strict';

/* ---------- Outils ---------- */
const $ = s => document.querySelector(s);
const nf = new Intl.NumberFormat('fr-FR', {maximumFractionDigits: 2});
const eur = n => nf.format(Number(n)) + ' €';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); d.setHours(12,0,0,0); return d; };
const ymOf = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addM = (ym, n) => { const [y,m] = ym.split('-').map(Number); return ymOf(new Date(y, m-1+n, 1, 12)); };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const mLabel = (ym, long) => { const [y,m] = ym.split('-').map(Number); return cap(new Date(y, m-1, 15).toLocaleDateString('fr-FR', long ? {month:'long', year:'numeric'} : {month:'short'})).replace('.', ''); };
const num = v => { const n = Number(String(v ?? '').replace(/\s/g,'').replace(',', '.')); return isFinite(n) ? n : NaN; };
const METHODS = ['Wave', 'Orange Money', 'Virement', 'Espèces', 'Autre'];
const ERRORS = {
  non_connecte: 'Connexion impossible. Vérifiez votre réseau et réessayez.',
  membres_2_a_40: 'Une tontine compte entre 2 et 40 membres.',
  position_invalide: 'Votre numéro de tour doit correspondre à une place dans la liste.',
  invitation_inconnue: 'Ce lien d\'invitation n\'existe pas ou a été remplacé. Demandez un nouveau lien à la gérante.',
  invitation_deja_utilisee: 'Ce lien a déjà été utilisé sur un autre téléphone. Demandez un nouveau lien à la gérante.',
  deja_membre: 'Vous faites déjà partie de cette tontine sur ce téléphone.',
  pas_membre: 'Vous ne faites pas partie de cette tontine.',
  tour_invalide: 'Ce tour n\'existe pas.',
  reserve_gerante: 'Seule la gérante peut faire cette action.',
  non_autorise: 'Vous n\'avez pas le droit de faire cette action.',
  pas_pour_la_gerante: 'La gérante utilise son lien de secours.'
};
const errMsg = e => {
  const m = (e && (e.message || e.error_description || String(e))) || '';
  for (const k of Object.keys(ERRORS)) if (m.includes(k)) return ERRORS[k];
  if (/fetch|network|Failed/i.test(m)) return 'Pas de connexion Internet pour le moment. Réessayez dans un instant.';
  return 'Une erreur est survenue. Réessayez dans un instant.';
};

/* ---------- Connexion ---------- */
const CFG = window.TONTINE_CONFIG || {};
const configured = CFG.url && !/VOTRE/.test(CFG.url) && CFG.key && !/VOTRE/.test(CFG.key);
const sb = configured ? window.supabase.createClient(CFG.url, CFG.key, {auth: {persistSession: true, autoRefreshToken: true, storageKey: 'tontine-claire-auth'}}) : null;

/* ---------- État ---------- */
const U = {view: 'loading', uid: null, list: [], tid: null, d: null, err: '', join: null, confirm: null, busy: false, lastLoad: 0};

/* ---------- Données ---------- */
async function ensureSession(){
  let {data: {session}} = await sb.auth.getSession();
  if (!session){
    const r = await sb.auth.signInAnonymously();
    if (r.error) throw r.error;
    session = r.data.session;
  }
  U.uid = session.user.id;
}
async function loadList(){
  const [t, m] = await Promise.all([
    sb.from('tontines').select('id,name,amount,start_month,due_day').order('created_at', {ascending: false}),
    sb.from('members').select('tontine_id,name,is_admin').eq('user_id', U.uid)
  ]);
  if (t.error) throw t.error; if (m.error) throw m.error;
  U.list = t.data.map(x => ({...x, me: m.data.find(y => y.tontine_id === x.id)}));
}
async function loadTontine(id){
  const [t, m, p, a, i] = await Promise.all([
    sb.from('tontines').select('*').eq('id', id).maybeSingle(),
    sb.from('members').select('*').eq('tontine_id', id).order('position'),
    sb.from('payments').select('*').eq('tontine_id', id),
    sb.from('arrangements').select('*').eq('tontine_id', id).neq('status', 'cancelled').order('created_at'),
    sb.from('invites').select('member_id,token')
  ]);
  for (const r of [t, m, p, a, i]) if (r.error) throw r.error;
  if (!t.data) throw new Error('pas_membre');
  U.d = {t: t.data, members: m.data, payments: p.data, arr: a.data, invites: i.data};
  U.lastLoad = Date.now();
}
async function rpc(fn, args){ const r = await sb.rpc(fn, args); if (r.error) throw r.error; return r.data; }

/* ---------- Calculs ---------- */
function model(){
  const {t, members, payments, arr} = U.d, n = members.length, t0 = today();
  const start = t.start_month.slice(0, 7);
  const [sy, sm] = start.split('-').map(Number);
  const cur = (t0.getFullYear() - sy) * 12 + (t0.getMonth() + 1 - sm);
  const roundYm = r => addM(start, r);
  const due = r => { const [y, m] = roundYm(r).split('-').map(Number); return new Date(y, m-1, t.due_day, 23, 59); };
  const pay = (mid, r) => payments.find(p => p.member_id === mid && p.round === r);
  const arrOf = mid => arr.find(a => a.member_id === mid);
  const cell = (m, r) => {
    const p = pay(m.id, r);
    if (p){ if (p.status === 'declared') return 'declared'; const late = new Date(p.paid_on + 'T12:00:00') > new Date(due(r).getTime() + 5 * 864e5); return late ? 'late' : 'paid'; }
    const overdue = r < cur || (r === cur && t0 > due(r));
    if (!overdue) return r === cur ? 'open' : 'future';
    const a = arrOf(m.id); return a && a.status === 'accepted' ? 'arr' : 'missing';
  };
  const stats = m => {
    let dueN = 0, onTime = 0, unpaid = 0, paidN = 0;
    for (let r = 0; r < n; r++){
      const c = cell(m, r);
      if (c === 'paid' || c === 'late' || c === 'declared') paidN++;
      if (c === 'future' || c === 'open') continue;
      dueN++; if (c === 'paid' || c === 'declared') onTime++; if (c === 'missing' || c === 'arr') unpaid++;
    }
    return {score: dueN ? Math.round(onTime / dueN * 100) : 100, unpaid, retard: unpaid * Number(t.amount), restant: (n - paidN) * Number(t.amount), received: m.position < cur};
  };
  const me = members.find(m => m.user_id === U.uid);
  return {t, members, n, cur, roundYm, due, pay, arrOf, cell, stats, me, admin: me && me.is_admin, pot: n * Number(t.amount)};
}
function planText(M, a){
  const amt = Number(M.t.amount), next = Math.max(M.cur + 1, 0);
  if (a.kind === 'fin') return `reprendre ${eur(amt)} par mois et payer les ${eur(a.debt)} de retard à la fin de la tontine, en ${mLabel(M.roundYm(M.n - 1), true).toLowerCase()}`;
  const extra = Math.ceil(Number(a.debt) / a.months);
  return `payer ${eur(amt + extra)} par mois pendant ${a.months} mois (${eur(amt)} de cotisation + ${eur(extra)} de rattrapage), à partir de ${mLabel(M.roundYm(next), true).toLowerCase()}`;
}

/* ---------- Affichage ---------- */
const ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--on-accent)" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 4v8l5 3"/></svg>';
const header = () => `<header class="top"><div class="brand"><div class="mark">${ICON}</div><div><h1>Tontine Claire</h1><small>Chacune voit qui a cotisé, et ce qu'il reste</small></div></div>
  ${U.view === 'tontine' ? `<button class="iconbtn" data-a="refresh" aria-label="Actualiser"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button>` : ''}</header>`;

function render(){
  const app = $('#app');
  const body = {loading: () => `<div class="center">Chargement…</div>`, setup: setupView, error: errorView, home: homeView, create: createView, join: joinView, tontine: tontineView}[U.view] || errorView;
  app.innerHTML = header() + body();
}
function setupView(){
  return `<section class="card"><h2>Configuration à terminer</h2><p class="muted">Renseignez l'adresse du projet Supabase et la clé publique dans le fichier <b>config.js</b>, puis publiez à nouveau l'appli.</p></section>`;
}
function errorView(){
  return `<section class="card"><h2>Impossible d'ouvrir la tontine</h2><p class="muted">${esc(U.err || 'Une erreur est survenue.')}</p><div class="actions"><button class="primary" data-a="home">Retour à mes tontines</button><button class="ghost" data-a="reload">Réessayer</button></div></section>`;
}
function homeView(){
  return `<section class="card"><span class="label">Mes tontines</span>
    ${U.list.length ? '' : `<h2>Aucune tontine pour l'instant</h2><p class="muted">Pour rejoindre une tontine, ouvrez le lien d'invitation envoyé par la gérante. Pour en organiser une, créez-la ici.</p>`}
    <button class="primary" data-a="create">Créer une tontine</button></section>
  ${U.list.length ? `<div class="list">${U.list.map(x => `<button class="titem" data-a="open" data-v="${x.id}"><span><b>${esc(x.name)}</b><small>${eur(x.amount)} par mois · échéance le ${x.due_day}</small></span>${x.me && x.me.is_admin ? '<span class="role">Gérante</span>' : '<span class="role">Membre</span>'}</button>`).join('')}</div>` : ''}
  <p class="muted" style="font-size:.82rem">Votre accès est lié à ce téléphone. Si vous en changez, demandez un nouveau lien à la gérante.</p>`;
}
function createView(){
  const next = addM(ymOf(today()), 1);
  return `<button class="linkbtn" data-a="home">← Mes tontines</button>
  <form id="createf" class="card" novalidate><span class="label">Nouvelle tontine</span><h2>Organiser une tontine</h2>
    <div class="field"><label for="c-name">Nom de la tontine</label><input id="c-name" name="name" maxlength="80" placeholder="Ex. : Les Amies de Sarcelles" autocomplete="off"></div>
    <div class="row2"><div class="field"><label for="c-amount">Cotisation par mois (€)</label><input id="c-amount" name="amount" inputmode="decimal" placeholder="100"></div>
      <div class="field"><label for="c-due">À payer avant le</label><input id="c-due" name="due" type="number" min="1" max="28" value="10" inputmode="numeric"><small>jour du mois (1 à 28)</small></div></div>
    <div class="field"><label for="c-start">Premier mois</label><input id="c-start" name="start" type="month" value="${next}"></div>
    <div class="field"><label for="c-me">Votre prénom et nom</label><input id="c-me" name="me" maxlength="60" autocomplete="name"></div>
    <div class="field"><label for="c-others">Les autres membres</label><textarea id="c-others" name="others" placeholder="Un prénom et nom par ligne, dans l'ordre où elles recevront la cagnotte"></textarea><small>La première ligne reçoit la cagnotte le premier mois. Utilisez de vrais noms : tout le groupe les verra.</small></div>
    <div class="field"><label for="c-pos">Votre tour</label><input id="c-pos" name="pos" type="number" min="1" inputmode="numeric" placeholder="Ex. : 4"><small>1 = vous recevez la cagnotte le premier mois. Votre nom s'insère à cette place dans la liste.</small></div>
    <label class="check"><input type="checkbox" id="c-ok" name="ok"><span>J'informerai les membres que leur nom et leurs paiements seront visibles par tout le groupe.</span></label>
    <p class="err" id="cerr" hidden></p>
    <button class="primary" type="submit">Créer la tontine</button></form>`;
}
function joinView(){
  const j = U.join;
  if (!j || !j.preview) return `<section class="card"><h2>Lien d'invitation introuvable</h2><p class="muted">${esc(ERRORS.invitation_inconnue)}</p><button class="primary" data-a="home">Mes tontines</button></section>`;
  const p = j.preview;
  if (p.used) return `<section class="card"><h2>Lien déjà utilisé</h2><p class="muted">${esc(ERRORS.invitation_deja_utilisee)}</p><button class="primary" data-a="home">Mes tontines</button></section>`;
  return `<section class="card"><span class="label">${p.admin ? 'Lien de secours de la gérante' : 'Invitation'}</span><h2>${esc(p.tontine)}</h2>
    <p class="muted">${p.admin ? `Ce lien vous redonne l'accès de gérante sur ce téléphone, au nom de <b>${esc(p.member)}</b>. L'ancien téléphone perdra l'accès.` : `Vous êtes invitée en tant que <b>${esc(p.member)}</b>. Cotisation de ${eur(p.amount)} par mois, ${p.members} membres.`}</p>
    <div class="alert info"><h3>Ce que le groupe verra</h3><p>Votre nom, vos paiements et votre tour sont visibles par les membres de cette tontine, et par personne d'autre. C'est ce qui rend la tontine claire pour toutes.</p></div>
    <p class="err" id="jerr" ${U.err ? '' : 'hidden'}>${esc(U.err)}</p>
    <div class="actions"><button class="primary" data-a="claim" ${U.busy ? 'disabled' : ''}>${p.admin ? 'Récupérer mon accès' : 'Rejoindre la tontine'}</button></div></section>`;
}
function ring(paid, total){
  const r = 34, C = 2 * Math.PI * r, f = total ? paid / total : 0;
  return `<svg class="ring" viewBox="0 0 84 84" role="img" aria-label="${paid} sur ${total} ont payé"><circle cx="42" cy="42" r="${r}" fill="none" stroke="var(--line)" stroke-width="9"/><circle cx="42" cy="42" r="${r}" fill="none" stroke="var(--accent)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${C*f} ${C}" transform="rotate(-90 42 42)"/><text x="42" y="40" text-anchor="middle" font-size="17" font-weight="700" fill="var(--ink)">${paid}/${total}</text><text x="42" y="56" text-anchor="middle" font-size="9" fill="var(--muted)">ont payé</text></svg>`;
}
function tontineView(){
  const M = model(), {t, members, n, cur, me} = M;
  const inProgress = cur >= 0 && cur < n;
  const last = members[n - 1];
  let h = `<button class="linkbtn" data-a="home">← Mes tontines</button>
  <section class="card"><span class="label">${me && me.is_admin ? 'Vous êtes la gérante' : 'Votre tontine'}</span><h2>${esc(t.name)}</h2>
    <div class="facts"><span><b class="num">${eur(t.amount)}</b> par mois</span><span>${n} membres</span><span>cagnotte <b class="num">${eur(M.pot)}</b></span><span>avant le ${t.due_day} du mois</span></div>
    <div class="timeline" aria-hidden="true">${members.map((_, i) => `<i class="${i < cur ? 'done' : i === cur ? 'now' : ''}"></i>`).join('')}</div>
    <div class="endrow"><span>${cur < 0 ? `Commence en <b>${mLabel(M.roundYm(0), true).toLowerCase()}</b>` : cur >= n ? '<b>Tontine terminée</b>' : `Tour <b class="num">${cur + 1}</b> sur ${n}`}</span><span>Fin : <b>${M.due(n - 1).toLocaleDateString('fr-FR', {day: 'numeric', month: 'long', year: 'numeric'})}</b> (${esc(last.name)})</span></div></section>`;

  // Tour en cours
  if (inProgress){
    const ben = members.find(m => m.position === cur);
    const paidNow = members.filter(m => { const c = M.cell(m, cur); return c === 'paid' || c === 'late'; }).length;
    const days = Math.ceil((M.due(cur) - today()) / 864e5);
    const myCell = me ? M.cell(me, cur) : null;
    h += `<section class="card"><span class="label">Tour en cours · ${mLabel(M.roundYm(cur), true)}</span>
      <div class="round">${ring(paidNow, n)}<div><h3>${esc(ben.name)} reçoit ${eur(M.pot)}</h3><p class="muted">${days >= 0 ? `Échéance ${days === 0 ? 'aujourd\'hui' : `dans ${days} jour${days > 1 ? 's' : ''}`} (${t.due_day} ${mLabel(M.roundYm(cur)).toLowerCase()})` : 'Échéance dépassée'}</p></div></div>
      <div class="chips">${members.map(m => { const c = M.cell(m, cur); return `<span class="chip ${c === 'paid' || c === 'late' ? 'ok' : c === 'declared' ? 'dec' : c === 'missing' || c === 'arr' ? 'bad' : ''}">${c === 'paid' || c === 'late' ? '✓' : c === 'declared' ? '⏳' : c === 'missing' || c === 'arr' ? '!' : '…'} ${esc(m.name)}${me && m.id === me.id ? ' (vous)' : ''}</span>`; }).join('')}</div>
      ${me && (myCell === 'open' || myCell === 'missing' || myCell === 'arr') ? `<div class="actions"><button class="primary" data-a="declare" data-v="${cur}">J'ai payé ma cotisation</button></div>` : ''}
      ${myCell === 'declared' ? `<p class="muted">Paiement déclaré. La gérante doit le confirmer.</p>` : ''}
      ${M.admin ? `<div class="actions"><button class="ghost small" data-a="record">Enregistrer un paiement</button><button class="ghost small" data-a="remindall">Rappel au groupe</button></div>` : ''}</section>`;
  }

  // Ce qui me concerne : arrangement proposé
  const myArr = me && M.arrOf(me.id);
  if (myArr && myArr.status === 'proposed') h += `<section class="alert info"><h3>Un arrangement vous est proposé</h3><p>La gérante vous propose de ${esc(planText(M, myArr))}. Le groupe voit qu'un arrangement existe, jamais les raisons.</p>
    <div class="actions"><button class="primary small" data-a="arrresp" data-v="${myArr.id}" data-ok="1">J'accepte</button><button class="ghost small" data-a="arrresp" data-v="${myArr.id}" data-ok="0">Je préfère en parler</button></div></section>`;

  // Gérante : paiements à confirmer
  if (M.admin){
    const decl = U.d.payments.filter(p => p.status === 'declared').sort((a, b) => a.created_at < b.created_at ? -1 : 1);
    if (decl.length) h += `<section class="card"><span class="label">À confirmer · ${decl.length}</span>${decl.map(p => { const m = members.find(x => x.id === p.member_id);
      return `<div class="pending"><span>${esc(m ? m.name : '?')} · ${mLabel(M.roundYm(p.round), true)}<small>${eur(p.amount)} par ${esc(p.method)}, déclaré le ${new Date(p.paid_on + 'T12:00:00').toLocaleDateString('fr-FR')}</small></span>
        <span class="actions" style="flex:0 0 auto"><button class="primary small" data-a="confirm" data-v="${p.id}">Reçu</button><button class="ghost small" data-a="reject" data-v="${p.id}">${U.confirm === p.id ? 'Confirmer le refus' : 'Pas reçu'}</button></span></div>`; }).join('')}</section>`;
  }

  // Membres qui ont touché leur part et ne paient plus
  members.forEach(m => {
    const s = M.stats(m), a = M.arrOf(m.id);
    if (!(s.received && s.unpaid > 0)) return;
    if (a && a.status === 'accepted'){
      h += `<section class="alert soft"><h3>Arrangement en cours · ${esc(m.name)}</h3><p>${esc(cap(planText(M, a)))}. Retard à rattraper : ${eur(s.retard)}.</p>${M.admin ? `<div class="actions"><button class="ghost small" data-a="arrcancel" data-v="${a.id}">Annuler l'arrangement</button></div>` : ''}</section>`;
    } else {
      h += `<section class="alert"><h3>${esc(m.name)} a reçu sa part et a ${s.unpaid} mois de retard</h3>
        <p>Elle a reçu ${eur(M.pot)} en ${mLabel(M.roundYm(m.position), true).toLowerCase()}. Retard : <b>${eur(s.retard)}</b>. Il lui reste ${eur(s.restant)} à verser d'ici la fin.</p>
        ${a && a.status === 'proposed' ? `<p>Un arrangement lui a été proposé, en attente de sa réponse.</p>` : ''}
        ${M.admin ? `<div class="actions"><button class="primary small" data-a="arrange" data-v="${m.id}">${a ? 'Proposer un autre arrangement' : 'Proposer un arrangement'}</button><button class="ghost small" data-a="remind" data-v="${m.id}">Relancer</button></div>` : ''}</section>`;
    }
  });

  // Tableau public
  h += `<section class="card"><span class="label">Qui a cotisé · visible par tout le groupe</span>
    <div class="gridwrap"><table><thead><tr><th class="name">Membre</th>${members.map((_, r) => `<th class="${r === cur ? 'cur' : ''}">${mLabel(M.roundYm(r))}</th>`).join('')}</tr></thead><tbody>
    ${members.map(m => { const s = M.stats(m), sc = s.score >= 90 ? 'sc-hi' : s.score >= 70 ? 'sc-mid' : 'sc-lo';
      return `<tr><td class="name"><b>${esc(m.name)}${me && m.id === me.id ? ' (vous)' : ''}<span class="score ${sc}">${s.score} %</span></b><small>${m.is_admin ? 'gérante' : m.user_id ? 'a rejoint' : 'pas encore inscrite'}</small></td>${members.map((_, r) => {
        const c = M.cell(m, r), sym = {paid: '✓', late: '✓', declared: '⏳', missing: '✕', arr: '≈', open: '…', future: '·'}[c];
        const tip = {paid: 'payé à temps', late: 'payé en retard', declared: 'déclaré, à confirmer', missing: 'non payé', arr: 'couvert par un arrangement', open: 'pas encore payé', future: 'à venir'}[c];
        return `<td class="c"><span class="s-${c}${m.position === r ? ' pot' : ''}" title="${esc(m.name)}, ${mLabel(M.roundYm(r), true)} : ${tip}${m.position === r ? ' · reçoit la cagnotte' : ''}">${sym}</span></td>`; }).join('')}</tr>`; }).join('')}
    </tbody></table></div>
    <div class="legend"><span><i class="s-paid"></i>payé</span><span><i class="s-late"></i>en retard</span><span><i class="s-declared"></i>à confirmer</span><span><i class="s-missing"></i>non payé</span><span><i class="s-arr"></i>arrangement</span><span><i style="width:6px;height:6px;border-radius:50%;background:var(--accent)"></i>reçoit la cagnotte</span></div>
    <p class="muted" style="font-size:.82rem">Le pourcentage indique la part des cotisations payées à l'heure dans cette tontine.</p></section>`;

  // Ordre des tours
  h += `<section class="card"><span class="label">Ordre des tours</span><div class="turns">${members.map(m => { const s = M.stats(m);
    const tag = m.position < cur ? (s.unpaid ? (M.arrOf(m.id) && M.arrOf(m.id).status === 'accepted' ? '<span class="tag t-now">a reçu · arrangement</span>' : '<span class="tag t-debt">a reçu · en retard</span>') : '<span class="tag t-done">a reçu</span>') : m.position === cur ? '<span class="tag t-now">ce mois-ci</span>' : '<span class="tag t-next">à venir</span>';
    return `<div class="turn ${m.position === cur ? 'now' : ''}"><span class="m">${mLabel(M.roundYm(m.position), true)}</span><span>${esc(m.name)}${me && m.id === me.id ? ' (vous)' : ''}</span>${tag}</div>`; }).join('')}</div></section>`;

  // Gérante : invitations
  if (M.admin){
    h += `<section class="card"><span class="label">Invitations</span><p class="muted">Envoyez à chaque membre son lien personnel. Un lien ne fonctionne que sur un seul téléphone.</p>
      ${members.filter(m => !m.is_admin).map(m => { const inv = U.d.invites.find(i => i.member_id === m.id);
        return `<div class="inv"><div class="invhead"><b>${esc(m.name)}</b><span class="tag ${m.user_id ? 't-done' : 't-next'}">${m.user_id ? 'a rejoint' : 'pas encore inscrite'}</span></div>
          <div class="actions">${!m.user_id && inv ? `<button class="primary small" data-a="invmsg" data-v="${m.id}">Message d'invitation</button>` : ''}<button class="ghost small" data-a="newlink" data-v="${m.id}">${U.confirm === 'nl' + m.id ? 'Confirmer : nouveau lien' : m.user_id ? 'Elle a changé de téléphone' : 'Nouveau lien'}</button></div></div>`; }).join('')}
      <div class="inv"><div class="invhead"><b>Votre lien de secours</b></div><p class="muted" style="font-size:.85rem">Si vous changez de téléphone, ce lien vous redonne l'accès de gérante. Gardez-le pour vous, ne le partagez pas.</p>
        <div class="actions"><button class="ghost small" data-a="mylink">Afficher mon lien de secours</button></div></div></section>`;
  }

  h += `<section class="card"><span class="label">Règles du groupe</span><ol class="rules">
    <li>Chaque membre déclare son paiement dans l'appli ; la gérante le confirme à réception.</li>
    <li>Toutes les cotisations restent visibles par tout le groupe jusqu'à la fin.</li>
    <li>En cas de difficulté, le retard peut être étalé. Le groupe voit l'arrangement, jamais les raisons.</li>
    <li>Après deux mois sans paiement ni arrangement, le groupe se réunit pour décider de la suite.</li></ol></section>`;
  if (M.admin) h += `<section class="card"><span class="label">Gestion</span>${U.confirm === 'del' ? `<p class="muted"><b>Supprimer définitivement cette tontine ?</b> Tous les paiements enregistrés seront effacés pour toutes les membres.</p><div class="actions"><button class="danger solid" data-a="deltontine">Oui, supprimer</button><button class="ghost" data-a="cancelconfirm">Annuler</button></div>` : `<button class="danger" data-a="askdel">Supprimer la tontine</button>`}</section>`;
  return h;
}

/* ---------- Feuilles ---------- */
function sheet(title, body, submit, onSubmit){
  const L = $('#layer');
  L.innerHTML = `<div class="sheetwrap" data-a="close"><form class="sheet" id="sheet" novalidate role="dialog" aria-label="${esc(title)}"><h2>${title}</h2>${body}<p class="err" id="serr" hidden></p>
    <div class="actions"><button type="button" class="ghost" data-a="close">Fermer</button>${submit ? `<button type="submit" class="primary">${submit}</button>` : ''}</div></form></div>`;
  const f = $('#sheet');
  f.addEventListener('submit', async e => {
    e.preventDefault(); const btn = f.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    try { const r = await onSubmit(new FormData(f)); if (r === true){ L.innerHTML = ''; } else if (r){ const er = $('#serr'); er.textContent = r; er.hidden = false; } }
    catch(err){ const er = $('#serr'); er.textContent = errMsg(err); er.hidden = false; }
    if (btn) btn.disabled = false;
  });
}
const closeSheet = () => { $('#layer').innerHTML = ''; };
function textSheet(title, intro, text){
  sheet(title, `<p class="muted">${intro}</p><div class="field"><label for="msg">Message</label><textarea id="msg">${esc(text)}</textarea></div><button type="button" class="primary" data-a="copy">Copier le message</button>`, null, null);
}
function toast(m){ const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2800); }
const inviteUrl = tok => `${location.origin}${location.pathname}?i=${tok}`;

/* ---------- Navigation ---------- */
async function go(view, id){
  U.err = ''; U.confirm = null;
  try {
    if (view === 'home'){ U.view = 'loading'; render(); await loadList(); history.replaceState(null, '', location.pathname); }
    if (view === 'tontine'){ U.view = 'loading'; render(); U.tid = id; await loadTontine(id); history.replaceState(null, '', location.pathname + '#t-' + id); }
    U.view = view;
  } catch(e){ U.err = errMsg(e); U.view = 'error'; }
  render(); window.scrollTo(0, 0);
}
async function refresh(quiet){
  if (U.view !== 'tontine') return;
  try { await loadTontine(U.tid); render(); if (!quiet) toast('À jour'); } catch(e){ if (!quiet) toast(errMsg(e)); }
}
async function act(fn, args, okMsg){
  try { await rpc(fn, args); await loadTontine(U.tid); U.confirm = null; render(); if (okMsg) toast(okMsg); return true; }
  catch(e){ toast(errMsg(e)); return false; }
}

/* ---------- Actions ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a, v = b.dataset.v;
  if (a === 'close'){ if (e.target === b || b.tagName === 'BUTTON') closeSheet(); return; }
  if (a === 'home') return go('home');
  if (a === 'reload') return location.reload();
  if (a === 'create'){ U.view = 'create'; render(); window.scrollTo(0, 0); return; }
  if (a === 'open') return go('tontine', v);
  if (a === 'refresh') return refresh(false);
  if (a === 'cancelconfirm'){ U.confirm = null; render(); return; }
  if (a === 'copy'){ const ta = $('#msg'); try { await navigator.clipboard.writeText(ta.value); toast('Message copié'); } catch(err){ ta.focus(); ta.select(); toast('Message sélectionné : copiez-le avec un appui long'); } return; }
  if (a === 'claim'){
    U.busy = true; U.err = ''; render();
    try { const tid = await rpc('claim_invite', {p_token: U.join.token}); U.busy = false; toast(U.join.preview.admin ? 'Accès de gérante récupéré' : 'Bienvenue dans la tontine'); return go('tontine', tid); }
    catch(err){ U.busy = false; U.err = errMsg(err); render(); return; }
  }
  if (U.view !== 'tontine' || !U.d) return;
  const M = model(), byId = id => M.members.find(m => m.id === id);
  const dateSel = `<div class="field"><label for="s-date">Payé le</label><input id="s-date" name="date" type="date" value="${isoOf(today())}" max="${isoOf(today())}"></div>`;
  const methodSel = `<div class="field"><label for="s-meth">Moyen de paiement</label><select id="s-meth" name="meth">${METHODS.map(x => `<option>${x}</option>`).join('')}</select></div>`;
  const roundSel = def => `<div class="field"><label for="s-round">Pour le mois de</label><select id="s-round" name="round">${M.members.map((_, r) => r <= Math.max(M.cur, 0) ? `<option value="${r}" ${r === def ? 'selected' : ''}>${mLabel(M.roundYm(r), true)}</option>` : '').join('')}</select></div>`;
  switch (a){
    case 'declare': {
      const unpaid = M.members.map((_, r) => r).filter(r => r <= M.cur && ['open', 'missing', 'arr'].includes(M.cell(M.me, r)));
      const def = unpaid.length ? unpaid[0] : Number(v);
      return sheet('J\'ai payé ma cotisation', `<p class="muted">${eur(M.t.amount)}. La gérante confirmera à réception ; en attendant, le groupe voit « à confirmer ».</p>${roundSel(def)}${methodSel}${dateSel}`, 'Déclarer le paiement',
        async fd => { await rpc('declare_payment', {p_tontine: M.t.id, p_round: Number(fd.get('round')), p_method: fd.get('meth'), p_paid_on: fd.get('date') || null}); await loadTontine(U.tid); render(); toast('Paiement déclaré'); return true; });
    }
    case 'record':
      return sheet('Enregistrer un paiement', `<p class="muted">Pour un paiement reçu en main propre, ou par un membre qui n'utilise pas l'appli.</p>
        <div class="field"><label for="s-mem">Membre</label><select id="s-mem" name="mem">${M.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>${roundSel(Math.max(M.cur, 0))}${methodSel}${dateSel}`, 'Enregistrer',
        async fd => { await rpc('admin_record_payment', {p_member: fd.get('mem'), p_round: Number(fd.get('round')), p_method: fd.get('meth'), p_paid_on: fd.get('date') || null}); await loadTontine(U.tid); render(); toast('Paiement enregistré'); return true; });
    case 'confirm': return act('confirm_payment', {p_payment: v}, 'Paiement confirmé');
    case 'reject':
      if (U.confirm !== v){ U.confirm = v; render(); return; }
      return act('delete_payment', {p_payment: v}, 'Déclaration retirée');
    case 'arrange': {
      const m = byId(v), s = M.stats(m), left = M.n - 1 - M.cur;
      const opt = (val, n, checked) => `<label class="opt"><input type="radio" name="plan" value="${val}" ${checked ? 'checked' : ''}><span><b>${n === 0 ? 'Reporter le retard à la fin' : `Étaler sur ${n} mois`}</b><small>${n === 0 ? `${eur(M.t.amount)} par mois, puis ${eur(s.retard)} au dernier tour` : `${eur(Number(M.t.amount) + Math.ceil(s.retard / n))} par mois pendant ${n} mois`}</small></span></label>`;
      const ns = [2, 3, 4].filter(n => n <= left);
      return sheet(`Arrangement pour ${esc(m.name)}`, `<p class="muted">Retard actuel : <b>${eur(s.retard)}</b>. Elle recevra la proposition dans l'appli et pourra l'accepter.</p><div class="opts">${ns.map((n, i) => opt('n' + n, n, i === 0)).join('')}${opt('fin', 0, !ns.length)}</div>`, 'Proposer',
        async fd => { const p = fd.get('plan'); await rpc('propose_arrangement', {p_member: m.id, p_kind: p === 'fin' ? 'fin' : 'etaler', p_months: p === 'fin' ? null : Number(p.slice(1)), p_debt: s.retard}); await loadTontine(U.tid); render(); toast('Arrangement proposé'); return true; });
    }
    case 'arrresp': return act('respond_arrangement', {p_arrangement: v, p_accept: b.dataset.ok === '1'}, b.dataset.ok === '1' ? 'Arrangement accepté' : 'Réponse envoyée à la gérante');
    case 'arrcancel': return act('respond_arrangement', {p_arrangement: v, p_accept: false}, 'Arrangement annulé');
    case 'remind': {
      const m = byId(v), s = M.stats(m);
      return textSheet(`Relancer ${esc(m.name)}`, 'Copiez ce message et envoyez-le sur WhatsApp.', `Bonjour ${m.name}, j'espère que tout va bien. Pour la tontine ${M.t.name}, tu as reçu la cagnotte de ${eur(M.pot)} en ${mLabel(M.roundYm(m.position), true).toLowerCase()}, mais il manque ${eur(s.retard)} de cotisations (${s.unpaid} mois). Peux-tu me dire quand tu pourras régulariser ? Si c'est difficile en ce moment, on peut trouver un arrangement ensemble.`);
    }
    case 'remindall': {
      const late = M.members.filter(m => ['open', 'missing'].includes(M.cell(m, M.cur))).map(m => m.name);
      const ben = M.members.find(m => m.position === M.cur);
      return textSheet('Rappel au groupe', 'Copiez ce message et envoyez-le dans le groupe WhatsApp.', `Bonjour à toutes ! Petit rappel pour la tontine ${M.t.name} : la cotisation de ${eur(M.t.amount)} pour ${mLabel(M.roundYm(M.cur), true).toLowerCase()} est attendue avant le ${M.t.due_day}. ${late.length ? `Il manque encore : ${late.join(', ')}.` : 'Tout le monde a payé, merci !'} ${ben ? ben.name + ' compte sur nous.' : ''} Pensez à déclarer votre paiement dans l'appli.`);
    }
    case 'invmsg': {
      const m = byId(v), inv = U.d.invites.find(i => i.member_id === v);
      return textSheet(`Inviter ${esc(m.name)}`, 'Envoyez ce message à elle seule : le lien est personnel.', `Bonjour ${m.name} ! Je t'invite dans notre tontine « ${M.t.name} » sur Tontine Claire : ${eur(M.t.amount)} par mois, ${m.position < M.cur ? 'ton tour de cagnotte était' : 'tu recevras la cagnotte'} en ${mLabel(M.roundYm(m.position), true).toLowerCase()}. Tout le groupe voit qui a cotisé, c'est plus simple pour toutes. Ton lien personnel (à ouvrir sur ton téléphone) : ${inviteUrl(inv.token)}`);
    }
    case 'newlink': {
      if (U.confirm !== 'nl' + v){ U.confirm = 'nl' + v; render(); return; }
      try { await rpc('reset_invite', {p_member: v}); await loadTontine(U.tid); U.confirm = null; render(); toast('Nouveau lien créé : l\'ancien ne fonctionne plus'); act2('invmsg', v); }
      catch(err){ toast(errMsg(err)); }
      return;
    }
    case 'mylink': {
      const inv = U.d.invites.find(i => i.member_id === M.me.id);
      if (!inv) return toast('Lien de secours indisponible pour cette tontine.');
      return textSheet('Votre lien de secours', 'Gardez ce lien en lieu sûr, par exemple dans vos notes. Ne l\'envoyez à personne : il donne l\'accès de gérante.', inviteUrl(inv.token));
    }
    case 'askdel': U.confirm = 'del'; render(); return;
    case 'deltontine':
      try { await rpc('delete_tontine', {p_tontine: M.t.id}); toast('Tontine supprimée'); return go('home'); }
      catch(err){ toast(errMsg(err)); return; }
  }
});
function act2(a, v){ const fake = document.createElement('button'); fake.dataset.a = a; fake.dataset.v = v; fake.hidden = true; document.body.appendChild(fake); fake.click(); fake.remove(); }

document.addEventListener('submit', async e => {
  if (e.target.id !== 'createf') return;
  e.preventDefault();
  const f = e.target, er = $('#cerr'), show = m => { er.textContent = m; er.hidden = false; };
  const name = f.name.value.trim(), amount = num(f.amount.value), due = Number(f.due.value), start = f.start.value, me = f.me.value.trim(), pos = Number(f.pos.value);
  const others = f.others.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!name) return show('Donnez un nom à la tontine.');
  if (!(amount > 0)) return show('Indiquez le montant de la cotisation mensuelle.');
  if (!(due >= 1 && due <= 28)) return show('Le jour d\'échéance doit être entre 1 et 28.');
  if (!/^\d{4}-\d{2}$/.test(start)) return show('Choisissez le premier mois (format AAAA-MM).');
  if (!me) return show('Indiquez votre prénom et nom.');
  if (!others.length) return show('Ajoutez au moins une autre membre.');
  const n = others.length + 1;
  if (n > 40) return show('Une tontine compte au maximum 40 membres.');
  if (!(pos >= 1 && pos <= n)) return show(`Votre tour doit être entre 1 et ${n}.`);
  if (others.some(o => o.length > 60)) return show('Chaque nom doit faire moins de 60 caractères.');
  if (!f.ok.checked) return show('Cochez la case d\'information des membres.');
  const list = others.slice(); list.splice(pos - 1, 0, me);
  const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    const tid = await rpc('create_tontine', {p_name: name, p_amount: amount, p_start: start + '-01', p_due: due, p_members: list, p_me: pos});
    toast('Tontine créée. Envoyez maintenant les invitations.');
    await go('tontine', tid);
  } catch(err){ show(errMsg(err)); btn.disabled = false; }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && U.view === 'tontine' && Date.now() - U.lastLoad > 20000) refresh(true); });

/* ---------- Démarrage ---------- */
async function boot(){
  if (!configured){ U.view = 'setup'; render(); return; }
  U.view = 'loading'; render();
  try { await ensureSession(); }
  catch(e){ U.err = errMsg(e); U.view = 'error'; render(); return; }
  const tok = new URLSearchParams(location.search).get('i');
  if (tok){
    try { U.join = {token: tok, preview: await rpc('invite_preview', {p_token: tok})}; } catch(e){ U.join = {token: tok, preview: null}; }
    U.view = 'join'; render(); return;
  }
  const m = location.hash.match(/^#t-([0-9a-f-]{36})$/);
  if (m) return go('tontine', m[1]);
  return go('home');
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
})();
