const form = document.querySelector('#settings');
const error = document.querySelector('#error');
const button = form.querySelector('button');
let csrf;
button.disabled = true;
fetch('/desktop/config').then(async response => {
  if (!response.ok) throw new Error('L’accès local a expiré. Quittez puis rouvrez Clock depuis Applications.');
  const config = await response.json();
  csrf = config.csrf;
  for (const field of ['email', 'username', 'hoursPerDay']) form.elements[field].value = config[field];
  if (config.hasPassword) {
    form.elements.password.required = false;
    form.elements.password.placeholder = 'Conserver le mot de passe enregistré';
    document.querySelector('#password-hint').textContent = 'Laissez le mot de passe vide pour conserver celui du Trousseau macOS.';
  }
  document.querySelector('#back').hidden = !config.configured;
  button.disabled = false;
}).catch(e => { error.textContent = e.message; error.hidden = false; });
form.addEventListener('submit', async event => {
  event.preventDefault(); button.disabled = true; error.hidden = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const response = await fetch('/desktop/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(values) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'L’enregistrement a échoué.');
    form.elements.password.value = '';
    location.replace('/');
  } catch (e) { error.textContent = e.message; error.hidden = false; button.disabled = false; }
});
