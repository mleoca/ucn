// Express-style routes
const express = require('express');
const app = express();

app.get('/users', listUsers);
app.post('/users', createUser);
app.put('/users/:id', updateUser);
app.delete('/users/:id', deleteUser);

function listUsers(req, res) { res.json([]); }
function createUser(req, res) { res.json({}); }
function updateUser(req, res) { res.json({}); }
function deleteUser(req, res) { res.json({}); }

module.exports = app;
