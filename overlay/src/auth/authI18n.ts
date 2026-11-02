import i18n from '../i18n'

/**
 * Translations for the login, dashboard and user management. Kept in this overlay module so the
 * upstream dictionaries do not have to be patched on every update.
 */
const de = {
  auth: {
    loginTitle: 'Willkommen bei Sweet3D',
    loginSubtitle: 'Melde dich an, um deine Projekte auf dem Server zu öffnen.',
    username: 'Benutzername',
    password: 'Passwort',
    signIn: 'Anmelden',
    signingIn: 'Anmelden …',
    logout: 'Abmelden',
    invalidCredentials: 'Benutzername oder Passwort ist falsch.',
    tooManyAttempts: 'Zu viele Versuche. Bitte warte einige Minuten.',
    serverUnavailable: 'Der Server ist nicht erreichbar.',
    signedInAs: 'Angemeldet als {{name}}',
    admin: 'Administrator',
    user: 'Benutzer',
    dashboard: 'Übersicht',
    welcome: 'Willkommen, {{name}}',
    launchApp: 'Sweet3D starten',
    launchHint:
      'Öffnet den Editor. Deine Projekte werden lokal gespeichert und automatisch mit dem Server synchronisiert.',
    serverStorage:
      'Projekte liegen auf dem Server und werden auf diesem Gerät zwischengespeichert. So stehen sie auf jedem Rechner zur Verfügung.',
    userManagement: 'Benutzerverwaltung',
  },
  admin: {
    title: 'Benutzer',
    newUser: 'Benutzer anlegen',
    username: 'Benutzername',
    password: 'Passwort',
    passwordHint: 'Mindestens 8 Zeichen.',
    role: 'Rolle',
    admin: 'Administrator',
    user: 'Benutzer',
    active: 'Aktiv',
    disabled: 'Gesperrt',
    createdAt: 'Angelegt',
    actions: 'Aktionen',
    resetPassword: 'Passwort zurücksetzen',
    newPassword: 'Neues Passwort',
    delete: 'Löschen',
    deleteConfirm: 'Benutzer „{{name}}“ wirklich löschen?',
    create: 'Anlegen',
    cancel: 'Abbrechen',
    save: 'Speichern',
    close: 'Schließen',
    self: 'Du',
    error: 'Aktion fehlgeschlagen.',
    lastAdmin: 'Mindestens ein aktiver Administrator muss bleiben.',
    usernameExists: 'Dieser Benutzername ist bereits vergeben.',
  },
  projects: {
    hint: 'Projekte werden auf dem Server gespeichert und automatisch mit diesem Gerät synchronisiert. Für eine Sicherung oder zum Öffnen in Sweet Home 3D als .sh3d herunterladen.',
  },
  sync: {
    saving: 'Speichere auf Server …',
    saved: 'Auf Server gespeichert',
    savedAt: 'Auf Server gespeichert · {{time}}',
    savedHint: 'Diese Version liegt auch auf dem Server ({{time}}).',
    localOnly: 'Nur lokal gespeichert',
    retryHint:
      'Der Server ist nicht erreichbar. Die Änderungen bleiben auf diesem Gerät und werden automatisch nachgereicht – hier klicken für einen neuen Versuch.',
  },
}

const en = {
  auth: {
    loginTitle: 'Welcome to Sweet3D',
    loginSubtitle: 'Sign in to open your projects from the server.',
    username: 'Username',
    password: 'Password',
    signIn: 'Sign in',
    signingIn: 'Signing in …',
    logout: 'Sign out',
    invalidCredentials: 'Wrong username or password.',
    tooManyAttempts: 'Too many attempts. Please wait a few minutes.',
    serverUnavailable: 'The server cannot be reached.',
    signedInAs: 'Signed in as {{name}}',
    admin: 'Administrator',
    user: 'User',
    dashboard: 'Dashboard',
    welcome: 'Welcome, {{name}}',
    launchApp: 'Launch Sweet3D',
    launchHint: 'Opens the editor. Your projects are stored locally and synchronized with the server automatically.',
    serverStorage:
      'Projects live on the server and are cached on this device, so they are available from any computer.',
    userManagement: 'User management',
  },
  admin: {
    title: 'Users',
    newUser: 'Create user',
    username: 'Username',
    password: 'Password',
    passwordHint: 'At least 8 characters.',
    role: 'Role',
    admin: 'Administrator',
    user: 'User',
    active: 'Active',
    disabled: 'Disabled',
    createdAt: 'Created',
    actions: 'Actions',
    resetPassword: 'Reset password',
    newPassword: 'New password',
    delete: 'Delete',
    deleteConfirm: 'Delete user “{{name}}”?',
    create: 'Create',
    cancel: 'Cancel',
    save: 'Save',
    close: 'Close',
    self: 'You',
    error: 'The action failed.',
    lastAdmin: 'At least one active administrator must remain.',
    usernameExists: 'This username is already taken.',
  },
  projects: {
    hint: 'Projects are stored on the server and synchronized with this device automatically. Download them as .sh3d for a backup or to open them in Sweet Home 3D.',
  },
  sync: {
    saving: 'Saving to server …',
    saved: 'Saved on server',
    savedAt: 'Saved on server · {{time}}',
    savedHint: 'This version is also stored on the server ({{time}}).',
    localOnly: 'Saved locally only',
    retryHint:
      'The server cannot be reached. Changes stay on this device and are uploaded automatically – click here to retry now.',
  },
}

i18n.addResourceBundle('de', 'translation', de, true, true)
i18n.addResourceBundle('en', 'translation', en, true, true)
