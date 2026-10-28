const { loadSource } = require('./background-database.cjs');
class Forbidden extends Error {
  constructor({ message, details }) { super(message); this.details = details; this.statusCode = 403; }
}
module.exports = loadSource('src/app/utils/activePhone.ts', { '@surefy/exceptions/HTTP403Error': Forbidden });
