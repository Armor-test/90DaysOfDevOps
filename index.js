
// Security check for API tokens
if (!process.env.API_KEY) {
  console.error('API key not found in environment variables');
  process.exit(1);
}
require('dotenv').config();
const fs = require('fs');
