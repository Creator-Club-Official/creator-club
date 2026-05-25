// ============================================================
//  Creator Club — Supabase Config
//  Edit the two lines below with your project values
//  Supabase Dashboard → Project Settings → API
// ============================================================

const SUPABASE_URL  = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON = 'YOUR_ANON_KEY_HERE';

// Resolve paths relative to wherever the app is hosted (works on GitHub Pages subpaths)
const BASE = (() => {
  const parts = window.location.pathname.split('/');
  // Strip the filename, keep the directory
  parts.pop();
  return parts.join('/') || '/';
})();

function appPath(page) {
  return BASE + '/' + page;
}

let _sb = null;
function getSB() {
  if (!_sb) _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  return _sb;
}

// ─── AUTH ─────────────────────────────────────────────────────
const Auth = {

  async signUp(makerworld_username, password) {
    const sb = getSB();
    const email = makerworld_username.toLowerCase().trim() + '@creatorclub.local';

    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { makerworld_username: makerworld_username.trim() } }
    });
    if (error) throw error;

    // Wait briefly for DB trigger to create profile, then upsert to be safe
    if (data.user) {
      await new Promise(r => setTimeout(r, 600));
      const { error: profileErr } = await sb.from('profiles').upsert({
        id: data.user.id,
        makerworld_username: makerworld_username.trim(),
      }, { onConflict: 'id' });
      if (profileErr) console.warn('Profile upsert warning:', profileErr.message);
    }
    return data;
  },

  async signIn(makerworld_username, password) {
    const sb = getSB();
    const email = makerworld_username.toLowerCase().trim() + '@creatorclub.local';
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    const sb = getSB();
    await sb.auth.signOut();
    window.location.href = appPath('login.html');
  },

  async getSession() {
    const sb = getSB();
    const { data } = await sb.auth.getSession();
    return data.session;
  },

  async getUser() {
    const sb = getSB();
    const { data } = await sb.auth.getUser();
    return data.user;
  },

  async getProfile(userId) {
    const sb = getSB();
    const uid = userId || (await this.getUser())?.id;
    if (!uid) return null;
    const { data } = await sb.from('profiles').select('*').eq('id', uid).single();
    return data;
  },

  // Redirect to login if not authenticated — uses correct relative path
  async requireAuth() {
    const session = await this.getSession();
    if (!session) {
      window.location.href = appPath('login.html');
      // Return a never-resolving promise so the rest of init() doesn't run
      return new Promise(() => {});
    }
    return session;
  }
};

// ─── CLUBS ────────────────────────────────────────────────────
const Clubs = {

  async getMyClub(creatorId) {
    const sb = getSB();
    const { data } = await sb.from('clubs').select('*').eq('creator_id', creatorId).single();
    return data;
  },

  async createClub(creatorId, name, description) {
    const sb = getSB();
    const { data, error } = await sb.from('clubs').insert({
      creator_id: creatorId,
      name,
      description
    }).select().single();
    if (error) throw error;
    return data;
  },

  async updateClub(clubId, updates) {
    const sb = getSB();
    const { data, error } = await sb.from('clubs').update(updates).eq('id', clubId).select().single();
    if (error) throw error;
    return data;
  }
};

// ─── CODES ────────────────────────────────────────────────────
const Codes = {

  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      if (i === 4) code += '-';
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  },

  async createCode(clubId, membership_status, is_one_time = false, max_uses = null) {
    const sb = getSB();
    const code = this.generateCode();
    const { data, error } = await sb.from('membership_codes').insert({
      club_id: clubId,
      code,
      membership_status,
      is_one_time,
      max_uses,
      uses: 0,
      is_active: true
    }).select().single();
    if (error) throw error;
    return data;
  },

  async listCodes(clubId) {
    const sb = getSB();
    const { data } = await sb.from('membership_codes')
      .select('*')
      .eq('club_id', clubId)
      .order('created_at', { ascending: false });
    return data || [];
  },

  async deactivateCode(codeId) {
    const sb = getSB();
    const { error } = await sb.from('membership_codes').update({ is_active: false }).eq('id', codeId);
    if (error) throw error;
  },

  async redeemCode(code, makerworld_username) {
    const sb = getSB();

    const { data: codeRow, error: codeErr } = await sb.from('membership_codes')
      .select('*, clubs(*)')
      .eq('code', code.toUpperCase().trim())
      .eq('is_active', true)
      .single();

    if (codeErr || !codeRow) throw new Error('Invalid or expired code.');
    if (codeRow.max_uses !== null && codeRow.uses >= codeRow.max_uses) {
      throw new Error('This code has reached its maximum uses.');
    }

    const user = await Auth.getUser();
    if (!user) throw new Error('Not logged in.');

    const clubId    = codeRow.club_id;
    const newStatus = codeRow.membership_status;

    const { data: existing } = await sb.from('memberships')
      .select('*').eq('user_id', user.id).eq('club_id', clubId).maybeSingle();

    if (existing) {
      let combinedStatus;
      if ((existing.membership_status === 1 && newStatus === 2) ||
          (existing.membership_status === 2 && newStatus === 1)) {
        combinedStatus = 3;
      } else {
        combinedStatus = Math.max(existing.membership_status, newStatus);
      }
      const { error: upErr } = await sb.from('memberships')
        .update({ membership_status: combinedStatus })
        .eq('id', existing.id);
      if (upErr) throw upErr;
    } else {
      const { error: insErr } = await sb.from('memberships').insert({
        user_id: user.id,
        club_id: clubId,
        makerworld_username: makerworld_username.trim(),
        membership_status: newStatus,
      });
      if (insErr) throw insErr;
    }

    const { error: useErr } = await sb.from('membership_codes').update({
      uses: codeRow.uses + 1,
      is_active: codeRow.is_one_time ? false : true
    }).eq('id', codeRow.id);
    if (useErr) console.warn('Code use increment warning:', useErr.message);

    return codeRow.clubs;
  }
};

// ─── MEMBERS ──────────────────────────────────────────────────
const Members = {

  async list(clubId) {
    const sb = getSB();
    const { data } = await sb.from('memberships')
      .select('*')
      .eq('club_id', clubId)
      .order('joined_at', { ascending: false });
    return data || [];
  },

  async getMyMemberships(userId) {
    const sb = getSB();
    const { data } = await sb.from('memberships')
      .select('*, clubs(name, description, creator_id, profiles!clubs_creator_id_fkey(makerworld_username))')
      .eq('user_id', userId);
    return data || [];
  },

  async getMembership(userId, clubId) {
    const sb = getSB();
    const { data } = await sb.from('memberships')
      .select('*').eq('user_id', userId).eq('club_id', clubId).maybeSingle();
    return data;
  }
};

// ─── POSTS ────────────────────────────────────────────────────
const Posts = {

  async create(clubId, type, title, body, target_status, scheduled_at = null, model_url = null) {
    const sb = getSB();
    const { data, error } = await sb.from('posts').insert({
      club_id: clubId,
      type,
      title,
      body,
      target_status,
      scheduled_at,
      model_url,
      is_published: scheduled_at === null,
    }).select().single();
    if (error) throw error;
    return data;
  },

  async listForClub(clubId, userStatus) {
    const sb = getSB();
    // Members with status 3 see everything; others see posts for their status or for everyone (3)
    let query = sb.from('posts')
      .select('*')
      .eq('club_id', clubId)
      .eq('is_published', true)
      .order('created_at', { ascending: false });

    if (userStatus === 3) {
      // See all
    } else {
      query = query.or(`target_status.eq.${userStatus},target_status.eq.3`);
    }

    const { data } = await query;
    return data || [];
  },

  async listAllForCreator(clubId) {
    const sb = getSB();
    const { data } = await sb.from('posts')
      .select('*')
      .eq('club_id', clubId)
      .order('created_at', { ascending: false });
    return data || [];
  },

  async archive(postId) {
    const sb = getSB();
    await sb.from('posts').update({ is_published: false }).eq('id', postId);
  }
};

// ─── POLLS ────────────────────────────────────────────────────
const Polls = {

  async create(postId, options) {
    const sb = getSB();
    const rows = options.map(opt => ({ post_id: postId, option_text: opt, votes: 0 }));
    const { data, error } = await sb.from('poll_options').insert(rows).select();
    if (error) throw error;
    return data;
  },

  async getOptions(postId) {
    const sb = getSB();
    const { data } = await sb.from('poll_options').select('*').eq('post_id', postId);
    return data || [];
  },

  async vote(optionId, userId) {
    const sb = getSB();
    const { data: existing } = await sb.from('poll_votes')
      .select('id').eq('option_id', optionId).eq('user_id', userId).maybeSingle();
    if (existing) throw new Error('Already voted.');
    const { error: vErr } = await sb.from('poll_votes').insert({ option_id: optionId, user_id: userId });
    if (vErr) throw vErr;
    await sb.rpc('increment_poll_votes', { option_id_param: optionId });
  },

  async hasVoted(postId, userId) {
    const sb = getSB();
    // Get all option ids for this post, then check if user voted on any
    const { data: opts } = await sb.from('poll_options').select('id').eq('post_id', postId);
    if (!opts || opts.length === 0) return false;
    const optIds = opts.map(o => o.id);
    const { data: votes } = await sb.from('poll_votes')
      .select('id')
      .eq('user_id', userId)
      .in('option_id', optIds);
    return votes && votes.length > 0;
  }
};

// ─── DMs ──────────────────────────────────────────────────────
const DMs = {

  async send(clubId, senderId, recipientId, content) {
    const sb = getSB();
    const { data, error } = await sb.from('messages').insert({
      club_id: clubId,
      sender_id: senderId,
      recipient_id: recipientId,
      content,
      is_read: false,
    }).select().single();
    if (error) throw error;
    return data;
  },

  async broadcast(clubId, senderId, targetStatus, content) {
    const sb = getSB();
    const members = await Members.list(clubId);
    const targets = members.filter(m => {
      if (targetStatus === 3) return true;
      return m.membership_status === targetStatus || m.membership_status === 3;
    });
    if (targets.length === 0) return [];
    const rows = targets.map(m => ({
      club_id: clubId,
      sender_id: senderId,
      recipient_id: m.user_id,
      content,
      is_broadcast: true,
      is_read: false,
    }));
    const { data, error } = await sb.from('messages').insert(rows).select();
    if (error) throw error;
    return data;
  },

  async getInbox(userId) {
    const sb = getSB();
    const { data } = await sb.from('messages')
      .select('*, sender:profiles!messages_sender_id_fkey(makerworld_username), clubs(name)')
      .eq('recipient_id', userId)
      .order('created_at', { ascending: false });
    return data || [];
  },

  async markRead(messageId) {
    const sb = getSB();
    await sb.from('messages').update({ is_read: true }).eq('id', messageId);
  },

  async getUnreadCount(userId) {
    const sb = getSB();
    const { count } = await sb.from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_id', userId)
      .eq('is_read', false);
    return count || 0;
  }
};

// ─── UI HELPERS ───────────────────────────────────────────────
const UI = {

  showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  },

  setLoading(btn, loading) {
    if (loading) {
      btn.dataset.originalText = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span>';
      btn.disabled = true;
    } else {
      btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
      btn.disabled = false;
    }
  },

  statusLabel(status) {
    return { 1: 'Follower', 2: 'Booster', 3: 'Follower & Booster' }[status] || 'Unknown';
  },

  statusBadge(status) {
    const cls = { 1: 'follower', 2: 'booster', 3: 'both' }[status] || 'follower';
    return `<span class="badge badge-${cls}">${this.statusLabel(status)}</span>`;
  },

  postTypeIcon(type) {
    return { announcement: '📢', model: '🧩', prerelease: '🔒', poll: '📊' }[type] || '📝';
  },

  formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
};
