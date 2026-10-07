'use strict';
const $ = (id) => document.getElementById(id);
const base = '/v1/facebook/login-test';
function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
async function post(endpoint) {
  const response = await fetch(base + endpoint, { method: 'POST', credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Request failed. Please retry.');
  return data;
}
async function init() {
  const result = new URLSearchParams(location.search).get('result');
  history.replaceState(null, '', location.pathname);
  const response = await fetch(base + '/config', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not load login configuration.');
  const data = await response.json();
  if (!data.ready) {
    notice(data.issue, true);
    return;
  }
  $('app-id').textContent = data.app_id;
  $('mode').textContent = data.mode === 'business' ? 'Facebook Login for Business' : 'Facebook Login (public profile)';
  $('callback').textContent = data.callback;
  $('login').disabled = false;
  if (data.profile) {
    $('profile').hidden = false;
    $('login').hidden = true;
    $('name').textContent = data.profile.name;
    $('user-id').textContent = data.profile.id;
    $('permissions').replaceChildren();
    data.profile.permissions.forEach((grant) => {
      const item = document.createElement('li');
      item.textContent = grant.permission + ' — ' + grant.status;
      $('permissions').append(item);
    });
    $('expiry').textContent = 'Test session expires at ' + new Date(data.profile.expires).toLocaleTimeString() + '.';
    setTimeout(() => location.reload(), Math.max(0, data.profile.expires - Date.now()) + 100);
  }
  const errors = {
    cancelled: 'Facebook login was cancelled or permission was declined. You can try again.',
    invalid_state: 'This login attempt expired or belongs to another browser. Start again here.',
    failed:
      'Facebook could not complete login. Check your app credentials, login product, redirect URI and account role, then retry.',
  };
  if (errors[result]) notice(errors[result], true);
  else
    notice(
      data.profile ? 'Facebook login verified successfully.' : 'Ready. Continue with Facebook to test your login.',
    );
}
$('login').addEventListener('click', async () => {
  $('login').disabled = true;
  notice('Opening Facebook…');
  try {
    const data = await post('/start');
    location.assign(data.url);
  } catch (error) {
    notice(error.message, true);
    $('login').disabled = false;
  }
});
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try {
    await post('/logout');
    location.replace(base);
  } catch (error) {
    notice(error.message, true);
    $('logout').disabled = false;
  }
});
init().catch((error) => notice(error.message, true));
