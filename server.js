require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

// Initialize cache with 30 minute TTL
const cache = new NodeCache({ stdTTL: 1800 });

const app = express();

// Trust proxy - add this line
app.set('trust proxy', 1);

app.use(cors());
app.use(express.static('public'));
app.use(express.static(__dirname));

// Middleware for logging requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Secure Google Credentials setup
let googleCredentials;
try {
  // First try to read from deployed secret file
  if (process.env.NODE_ENV === 'production') {
    googleCredentials = JSON.parse(
      fs.readFileSync('/etc/secrets/google-credentials.json', 'utf8')
    );
  } else {
    // For local development, use local file
    googleCredentials = require('./google-credentials.json');
  }
} catch (error) {
  console.error('Error loading credentials:', error);
  process.exit(1);
}

// Google Sheets API setup with secure credentials
const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Updated Rate limiting configuration
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    trustProxy: true
});

app.use(limiter);

// Utility functions
const formatCityData = (row) => ({
  city: row[0] || '',
  state: row[1] || '',
  country: row[2] || '',
  latitude: parseFloat(row[3]) || 0,
  longitude: parseFloat(row[4]) || 0
});

const getCacheKey = (endpoint, params) => {
  return `${endpoint}_${JSON.stringify(params)}`;
};

// Cities endpoint
app.get('/cities', async (req, res) => {
  try {
    const searchTerm = req.query.term?.toLowerCase();
    if (!searchTerm || searchTerm.length < 2) {
      return res.status(400).json({ error: 'Search term must be at least 2 characters' });
    }

    const cacheKey = getCacheKey('cities', searchTerm);
    const cachedResults = cache.get(cacheKey);
    if (cachedResults) {
      return res.json(cachedResults);
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'A1:E',
    });

    const rows = response.data.values;
    if (!rows || rows.length <= 1) {
      return res.json([]);
    }

    const filteredCities = rows.slice(1)
      .filter(row => row[0] && row[0].toLowerCase().includes(searchTerm))
      .map(formatCityData)
      .slice(0, 10); // Limit results to 10 cities

    cache.set(cacheKey, filteredCities);
    res.json(filteredCities);

  } catch (error) {
    console.error('Cities API error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch city data',
      message: error.message || 'Internal server error'
    });
  }
});

// Weather endpoint
app.get('/weather', async (req, res) => {
  try {
    const { latitude, longitude, date } = req.query;

    // Input validation
    if (!latitude || !longitude || !date) {
      return res.status(400).json({ 
        error: 'Missing parameters',
        message: 'Latitude, longitude, and date are required' 
      });
    }

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ 
        error: 'Invalid coordinates',
        message: 'Latitude and longitude must be valid numbers' 
      });
    }

    const cacheKey = getCacheKey('weather', { latitude, longitude, date });
    const cachedWeather = cache.get(cacheKey);
    if (cachedWeather) {
      return res.json(cachedWeather);
    }

    const requestDate = new Date(date);
    const today = new Date();
    
    const baseParams = `latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto&start_date=${date}&end_date=${date}`;
    
    const url = requestDate > today
      ? `https://api.open-meteo.com/v1/forecast?${baseParams}`
      : `https://archive-api.open-meteo.com/v1/era5?${baseParams}`;

    const response = await axios.get(url, { timeout: 5000 });
    const weatherData = response.data;

    if (!weatherData.daily?.temperature_2m_max?.length) {
      return res.status(404).json({ 
        error: 'No data available',
        message: 'No weather data available for this date and location' 
      });
    }

    // Add some derived data
    weatherData.meta = {
      requested_date: date,
      location: { latitude, longitude },
      data_source: requestDate > today ? 'forecast' : 'historical'
    };

    cache.set(cacheKey, weatherData);
    res.json(weatherData);

  } catch (error) {
    console.error('Weather API error:', error);
    
    if (error.response?.status === 404) {
      return res.status(404).json({ 
        error: 'Not found',
        message: 'Weather data not available for this date/location' 
      });
    }
    
    res.status(500).json({ 
      error: 'Weather API error',
      message: error.response?.data?.reason || error.message || 'Failed to fetch weather data'
    });
  }
});

// Serve index.html for root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Server error',
    message: 'An unexpected error occurred'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 10000;

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Server environment: ${process.env.NODE_ENV}`);
});

module.exports = app;