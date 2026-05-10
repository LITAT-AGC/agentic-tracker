#!/usr/bin/env node

// Force test environment before backend initialization.
process.env.NODE_ENV = 'test';

require('../index.js');
