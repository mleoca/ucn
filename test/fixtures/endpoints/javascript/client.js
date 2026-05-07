// Client requests using fetch and axios
async function loadUsers() {
    return await fetch('/users');
}

async function getUserById(id) {
    return await fetch(`/users/${id}`);
}

async function postUser(data) {
    return await axios.post('/users', data);
}

async function putUser(id, data) {
    return await axios.put(`/users/${id}`, data);
}

module.exports = { loadUsers, getUserById, postUser, putUser };
