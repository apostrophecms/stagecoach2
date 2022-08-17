const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2');
const express = require('express');
const app = express();
const { stripIndent } = require('common-tags');
const session = require('express-session');
const fs = require('fs');
const fetch = require('node-fetch');

const config = JSON.parse(fs.readFileSync(`${__dirname}/config.json`));

app.use(session({
  secret: 'ap9823hrq809273hr0q237y4',
  resave: false, // don't save session if unmodified
  saveUninitialized: false, // don't create session until something stored
  // store: new SQLiteStore({ db: 'sessions.db', dir: './var/db' })
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new OAuth2Strategy({
    authorizationURL: 'https://github.com/login/oauth/authorize',
    tokenURL: 'https://github.com/login/oauth/access_token',
    clientID: config.githubApp.id,
    clientSecret: config.githubApp.secret,
    callbackURL: "http://localhost:3000/auth/github/callback",
    scope: [ 'read:user' ]
  },
  async (accessToken, refreshToken, _profile, cb) => {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/vnd.github+json'
      }
    });
    if (response.status >= 400) {
      return cb(response.status);
    }
    const profile = await response.json();
    return cb(null, profile);
  })
);

passport.serializeUser(function(user, cb) {
  return cb(null, user);
});

passport.deserializeUser(function(user, cb) {
  return cb(null, user);
});

app.get(
  '/auth/github',
  passport.authenticate('oauth2')
);

app.get(
  '/auth/github/callback',
  passport.authenticate('oauth2', {
    failureRedirect: '/?error=login'
  }),
  function(req, res) {
    // Successful authentication, redirect home.
    res.redirect('/');
  }
);

app.get(
  '/',
  (req, res) => {
    return res.send(stripIndent`
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Home</title> 
  </head>
  <body>
    ${req.user ? stripIndent`
      <p>Hello, ${req.user.login}!</p>
    ` : stripIndent`
      <a href="/auth/github">Log in with Github</a>
    `
    }
  </body>
</html>`
    );
  }
);

app.listen(3000);
