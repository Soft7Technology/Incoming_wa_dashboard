'use strict';
const $ = (id) => document.getElementById(id),
  base = '/v1/facebook/api/posts';
let postsRender = 0;
let page,
  post,
  generation = 0,
  feedCursor,
  commentCursor,
  createRequest;
const el = (tag, text, className) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
};
function notice(text = '', success = false) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
  $('notice').className = success ? 'success' : 'error';
}
async function busy(node, run) {
  if (node.disabled) return;
  node.disabled = true;
  notice();
  try {
    await run();
  } catch (e) {
    notice(e.message);
  } finally {
    node.disabled = false;
  }
}
function button(text, run, className = 'quiet') {
  const n = el('button', text, className);
  n.type = 'button';
  n.onclick = () => busy(n, run);
  return n;
}
async function api(path, method = 'GET', body) {
  const response = await window.metaWorkspace.fetch(base + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.message || 'Facebook Page operation failed.');
  }
  return data.data;
}
function clearPage() {
  generation++;
  page = post = null;
  feedCursor = commentCursor = createRequest = null;
  $('page-workspace').hidden = $('comments-panel').hidden = true;
  for (const id of ['posts', 'comments', 'actions']) $(id).replaceChildren();
  $('post-form').reset();
  $('post-filter').value = 'all';
  $('more-feed').hidden = $('more-comments').hidden = true;
}
$('connect').onclick = () =>
  busy($('connect'), async () => {
    const data = await api('/oauth/start', 'POST', {}),
      url = new URL(data.authorization_url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com')
      throw new Error('Invalid Facebook authorization URL.');
    location.assign(url.toString());
  });
$('token-form').onsubmit = (event) => {
  event.preventDefault();
  busy($('use-token'), async () => {
    const value = $('access-token').value;
    $('access-token').value = '';
    await api('/oauth/token', 'POST', { access_token: value });
    await candidates();
    notice('Choose a Page authorized by this token.', true);
  });
};
async function candidates() {
  const data = await api('/oauth/pages');
  $('selection').hidden = data.status !== 'ready';
  $('page-select').replaceChildren(
    ...data.pages.map((p) => {
      const option = el('option', p.name + ' (' + p.page_id + ')');
      option.value = p.page_id;
      return option;
    }),
  );
  if (data.error) notice(data.error);
}
$('select-page').onclick = () =>
  busy($('select-page'), async () => {
    const connected = await api('/pages', 'POST', { page_id: $('page-select').value });
    await candidates();
    await pages();
    await openPage(connected);
    notice('Page connected for posts and community content.', true);
  });
async function pages() {
  const g = generation,
    rows = await api('/pages');
  if (g !== generation) return;
  $('pages').replaceChildren(
    ...rows.map((p) => {
      const card = el('article', undefined, 'card');
      card.append(
        el('h3', p.name),
        el('p', 'Page ' + p.page_id),
        el('p', p.status.replaceAll('_', ' ')),
        button('Open Page', () => openPage(p)),
        button('Disconnect', async () => {
          if (!confirm('Disconnect Page posts? Stored history will remain.')) return;
          await api('/pages/' + p.id + '/disconnect', 'POST', {});
          clearPage();
          await pages();
        }),
        button(
          'Delete stored integration',
          async () => {
            if (
              !confirm('Remove this integration and its local content history? Published Facebook posts will remain.')
            )
              return;
            await api('/pages/' + p.id, 'DELETE');
            clearPage();
            await pages();
          },
          'danger',
        ),
      );
      return card;
    }),
  );
  if (!rows.length) $('pages').append(el('p', 'No Pages connected for posts yet.', 'muted'));
}
async function openPage(p) {
  clearPage();
  page = p;
  $('page-workspace').hidden = false;
  $('page-name').textContent = p.name;
  $('posting-as').textContent = 'Publishing as ' + p.name + ' · Page ' + p.page_id;
  $('connection-state').textContent =
    p.status === 'connected'
      ? 'Connected. You can publish posts and read Page content.'
      : 'Reconnect this Page to refresh or publish. Stored history remains available.';
  $('compose-fields').disabled = $('refresh-feed').disabled = p.status !== 'connected';
  await renderPosts();
}
function current(g, id) {
  return generation === g && page?.id === id;
}
function resultNotice(result, success) {
  notice(
    result.status === 'confirmed'
      ? success
      : result.error || 'Action is awaiting confirmation. Check Facebook before repeating it.',
    result.status === 'confirmed',
  );
}
for (const id of ['post-text', 'post-link'])
  $(id).oninput = () => {
    createRequest = null;
  };
$('new-draft').onclick = () => {
  $('post-form').reset();
  createRequest = null;
};
$('post-form').onsubmit = (event) => {
  event.preventDefault();
  busy($('publish-post'), async () => {
    if (!page || page.status !== 'connected') throw new Error('Reconnect the Page before publishing.');
    const id = page.id,
      g = generation;
    createRequest ||= crypto.randomUUID();
    const request = createRequest;
    const result = await api('/pages/' + id + '/posts', 'POST', {
      message: $('post-text').value,
      link: $('post-link').value.trim(),
      client_request_id: request,
    });
    if (!current(g, id)) return;
    if (result.status === 'confirmed') {
      try {
        await api('/pages/' + id + '/posts/sync', 'POST', {});
      } catch {}
    }
    if (!current(g, id)) return;
    await renderPosts();
    resultNotice(result, 'Post published on Facebook.');
  });
};
async function renderPosts() {
  const revision = ++postsRender;
  const id = page?.id,
    g = generation;
  if (!id) return;
  const [rows, history] = await Promise.all([api('/pages/' + id + '/posts'), api('/pages/' + id + '/actions')]);
  if (!current(g, id) || revision !== postsRender) return;
  const filter = $('post-filter').value;
  const visible = rows.filter(
    (p) => filter === 'all' || (filter === 'page' ? p.from_page === true || p.managed : p.from_page === false),
  );
  $('posts').replaceChildren(
    ...visible.map((p) => {
      const card = el('article', undefined, 'card');
      card.append(
        el(
          'strong',
          p.deleted
            ? 'Deleted post'
            : p.from_page === false
              ? 'Visitor post'
              : p.from_page === true || p.managed
                ? 'Page post'
                : 'Feed post',
        ),
        el('p', p.author_name || 'Author unavailable'),
        el('p', p.message || '(No text on this post)'),
        el('small', new Date(p.created_at).toLocaleString()),
      );
      if (!p.deleted && p.permalink && /^https:\/\/(www\.)?facebook\.com\//.test(p.permalink)) {
        const a = el('a', 'View on Facebook');
        a.href = p.permalink;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        card.append(a);
      }
      if (!p.deleted)
        card.append(
          button('Read comments', async () => {
            if (!current(g, id)) return;
            post = p;
            commentCursor = null;
            $('more-comments').hidden = true;
            $('comments-panel').hidden = false;
            $('comments-title').textContent = 'Comments · ' + (p.message || p.remote_id).slice(0, 80);
            await renderComments();
            if (page.status === 'connected') await syncComments(false);
          }),
        );
      if (p.managed && !p.deleted && page.status === 'connected') {
        const form = el('form');
        form.hidden = true;
        const label = el('label', 'Edit post text'),
          text = el('textarea');
        text.value = p.message;
        text.required = true;
        text.maxLength = 5000;
        label.append(text);
        const save = el('button', 'Save changes');
        form.append(label, save);
        let editRequest;
        text.oninput = () => {
          editRequest = null;
        };
        form.onsubmit = (event) => {
          event.preventDefault();
          busy(save, async () => {
            editRequest ||= crypto.randomUUID();
            const result = await api('/pages/' + id + '/posts/' + p.id, 'PATCH', {
              message: text.value,
              client_request_id: editRequest,
            });
            if (!current(g, id)) return;
            await renderPosts();
            resultNotice(result, 'Post updated on Facebook.');
          });
        };
        let deleteRequest;
        card.append(
          button('Edit post', async () => {
            form.hidden = !form.hidden;
          }),
          button(
            'Delete post',
            async () => {
              if (!confirm('Delete this published post from Facebook?')) return;
              deleteRequest ||= crypto.randomUUID();
              const result = await api('/pages/' + id + '/posts/' + p.id, 'DELETE', {
                client_request_id: deleteRequest,
              });
              if (!current(g, id)) return;
              await renderPosts();
              resultNotice(result, 'Post deleted from Facebook.');
            },
            'danger',
          ),
          form,
        );
      }
      return card;
    }),
  );
  if (!visible.length)
    $('posts').append(
      el(
        'p',
        filter === 'visitor'
          ? 'No visitor posts imported. You can read customer comments by opening a Page post.'
          : 'No posts imported. Click Refresh feed or publish your first post.',
        'muted',
      ),
    );
  $('actions').replaceChildren(
    ...history.map((a) => el('p', a.kind + ' · ' + a.status + (a.error ? ' · ' + a.error : ''))),
  );
  if (!history.length) $('actions').append(el('p', 'No publishing actions yet.', 'muted'));
}
$('post-filter').onchange = () => renderPosts().catch((e) => notice(e.message));
async function syncFeed(more) {
  if (!page) return;
  const id = page.id,
    g = generation;
  const result = await api('/pages/' + id + '/posts/sync', 'POST', more ? { after: feedCursor } : {});
  if (!current(g, id)) return;
  feedCursor = result.next_cursor;
  $('more-feed').hidden = !feedCursor;
  await renderPosts();
}
$('refresh-feed').onclick = () => busy($('refresh-feed'), () => syncFeed(false));
$('more-feed').onclick = () => busy($('more-feed'), () => syncFeed(true));
async function renderComments() {
  if (!page || !post) return;
  const id = page.id,
    postId = post.id,
    g = generation;
  const rows = await api('/pages/' + id + '/posts/' + postId + '/comments');
  if (!current(g, id) || post?.id !== postId) return;
  $('comments').replaceChildren(
    ...rows.map((c) => {
      const card = el('article', undefined, 'card');
      card.append(
        el('strong', c.author_name || 'Facebook user'),
        el('p', c.message || '(No text in this comment)'),
        el('small', new Date(c.created_at).toLocaleString()),
      );
      return card;
    }),
  );
  if (!rows.length)
    $('comments').append(
      el('p', 'No comments imported. Add a comment from another Facebook account, then refresh comments.', 'muted'),
    );
  $('refresh-comments').disabled = page.status !== 'connected';
}
async function syncComments(more) {
  if (!page || !post) return;
  const id = page.id,
    postId = post.id,
    g = generation;
  const result = await api(
    '/pages/' + id + '/posts/' + postId + '/comments/sync',
    'POST',
    more ? { after: commentCursor } : {},
  );
  if (!current(g, id) || post?.id !== postId) return;
  commentCursor = result.next_cursor;
  $('more-comments').hidden = !commentCursor;
  await renderComments();
}
$('refresh-comments').onclick = () => busy($('refresh-comments'), () => syncComments(false));
$('more-comments').onclick = () => busy($('more-comments'), () => syncComments(true));
async function init() {
  const setup = await api('/setup');
  $('workspace').hidden = false;
  $('connect').disabled = !setup.ready;
  $('configuration').textContent = setup.issue || '';
  $('configuration').hidden = !setup.issue;
  $('use-token').disabled = !setup.token_ready;
  await pages();
  await candidates();
  if (location.hash.startsWith('#oauth=')) history.replaceState(null, '', location.pathname);
}
window.metaWorkspace.ready().then(init).catch((e) => notice(e.message));
