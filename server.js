const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const compression = require('compression');
const { query, validationResult } = require('express-validator');
const CircuitBreaker = require('opossum');

let envPath = process.env.NODE_ENV === 'production' ? '/etc/secrets/.env' : '.env';
require('dotenv').config({ path: envPath });

const cache = new NodeCache({ 
    stdTTL: 1800,
    checkperiod: 120
});

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static('public'));
app.use(express.static(__dirname));

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: true
});
app.use(limiter);

// Normalize country names
function normalizeCountryName(country) {
    const countryMappings = {
        'united states of america': 'united states',
        'usa': 'united states',
        'u.s.a.': 'united states',
        'u.s.': 'united states',
        'uk': 'united kingdom',
        'great britain': 'united kingdom'
    };
    return countryMappings[country.toLowerCase()] || country;
}

// Improved match quality calculation with stronger prefix matching
function calculateMatchQuality(cityName, searchTerm) {
    const cityLower = cityName.toLowerCase();
    const searchLower = searchTerm.toLowerCase();
    
    // Perfect match
    if (cityLower === searchLower) return 100;
    
    // Exact prefix match (e.g., "cup" matches "cupertino")
    if (cityLower.startsWith(searchLower)) return 95;
    
    // Word prefix match (e.g., "san f" matches "san francisco")
    const searchWords = searchLower.split(' ');
    const cityWords = cityLower.split(' ');
    
    if (searchWords.length > 0 && cityWords.length > 0) {
        if (cityWords[0].startsWith(searchWords[0])) {
            // If it's the start of the first word, give high score
            if (searchWords.length === 1) return 90;
            
            // If multiple words, check if they all match as prefixes
            const allWordsMatch = searchWords.every((searchWord, index) => 
                cityWords[index] && cityWords[index].startsWith(searchWord)
            );
            if (allWordsMatch) return 85;
        }
    }
    
    // Partial match anywhere in the name
    if (cityLower.includes(searchLower)) return 70;
    
    return 0;
}

const validateCitySearch = [
    query('term')
        .trim()
        .isLength({ min: 1 })
        .withMessage('Search term must not be empty')
        .escape(),
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        next();
    }
];

app.get('/cities', validateCitySearch, async (req, res) => {
    try {
        const searchTerm = req.query.term.trim();
        console.log('Search term:', searchTerm);

        const cacheKey = `cities_${searchTerm.toLowerCase()}`;
        const cachedResults = cache.get(cacheKey);
        if (cachedResults) {
            return res.json(cachedResults);
        }

        const response = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
            params: {
                q: searchTerm,
                key: process.env.OPENCAGE_API_KEY,
                limit: 20, // Increased limit to get more initial results
                no_annotations: 1,
                language: 'en'
            }
        });

        let cities = response.data.results
            .map(result => {
                const components = result.components;
                const cityName = components.city || 
                               components.town || 
                               components.municipality ||
                               components.village ||
                               components.county;

                if (!cityName) return null;

                // Normalize the country name
                const country = normalizeCountryName(components.country || '');

                let score = calculateMatchQuality(cityName, searchTerm);

                // Additional scoring factors
                if (components.capital === 'yes') score += 20;
                if (components.state_capital === 'yes') score += 10;
                if (components._type === 'city') score += 5;

                return {
                    city: cityName,
                    state: components.state || components.province || components.region,
                    country: country,
                    latitude: result.geometry.lat,
                    longitude: result.geometry.lng,
                    score: score,
                    formatted: result.formatted
                };
            })
            .filter(city => {
                if (!city) return false;
                return city.score > 0; // Only keep results with a matching score
            })
            .sort((a, b) => b.score - a.score);

        // Remove duplicates using a composite key of city+state+country
        cities = Array.from(new Map(
            cities.map(city => [
                `${city.city.toLowerCase()}-${(city.state || '').toLowerCase()}-${city.country.toLowerCase()}`,
                city
            ])
        ).values());

        // Take top 10 results
        const formattedCities = cities.slice(0, 10).map(city => ({
            city: city.city,
            state: city.state,
            country: city.country,
            latitude: city.latitude,
            longitude: city.longitude
        }));

        cache.set(cacheKey, formattedCities);
        res.json(formattedCities);

    } catch (error) {
        console.error('Cities API error:', error.response?.data || error);
        res.status(500).json({ 
            error: 'Failed to fetch city data',
            message: error.message || 'Internal server error'
        });
    }
});

app.get('/weather', async (req, res) => {
    try {
        const { latitude, longitude, date } = req.query;

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

        const cacheKey = `weather_${latitude}_${longitude}_${date}`;
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

        const response = await axios.get(url);
        const weatherData = response.data;

        if (!weatherData.daily?.temperature_2m_max?.length) {
            return res.status(404).json({ 
                error: 'No data available',
                message: 'No weather data available for this date and location' 
            });
        }

        cache.set(cacheKey, weatherData);
        res.json(weatherData);

    } catch (error) {
        console.error('Weather API error:', error.response?.data || error);
        res.status(500).json({ 
            error: 'Weather API error',
            message: error.message || 'Failed to fetch weather data'
        });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, req, res, next) => {
    console.error('Global error:', err.stack);
    res.status(500).json({ 
        error: 'Server error',
        message: 'An unexpected error occurred'
    });
});

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