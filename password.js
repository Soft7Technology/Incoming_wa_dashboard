const bcrypt = require('bcrypt');

const hash = '$2b$10$lW6NNgVn/WiyIimLEyXI6exIW7GzWIq.ahXUYBYSMDSfd0BhWMZbS';

const match = await bcrypt.compare('mypassword', hash);

console.log(match); // true or false