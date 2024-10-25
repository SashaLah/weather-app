const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const compression = require('compression');
const { query, validationResult } = require('express-validator');
const CircuitBreaker = require('opossum');
const swaggerUi = require('swagger-ui-express');

// Environment configuration
let envPath = process.env.NODE_ENV === 'production' ? '/etc/secrets/.env' : '.env';
require('dotenv').config({ path: envPath });

// Initialize cache with longer TTL for city data
const cache = new NodeCache({ 
    stdTTL: 1800,
    checkperiod: 120
});

// Initialize Express app
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static('public'));
app.use(express.static(__dirname));

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: true
});
app.use(limiter);

// Circuit breaker configurations
const opencageBreaker = new CircuitBreaker(
    async (config) => axios(config),
    {
        timeout: 5000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000
    }
);

opencageBreaker.fallback(async (config) => {
    // Fallback to cached data if available
    const cacheKey = `cities_${config.params.q.toLowerCase()}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) return { data: { results: cachedData } };
    throw new Error('Service unavailable and no cached data found');
});

// Enhanced match quality calculation
function calculateMatchQuality(cityName, searchTerm) {
    const cityLower = cityName.toLowerCase();
    const searchLower = searchTerm.toLowerCase();
    const searchParts = searchLower.split(' ').filter(part => part.length > 0);
    
    // Perfect match
    if (cityLower === searchLower) return 100;
    
    // Starts with exact search term
    if (cityLower.startsWith(searchLower)) return 90;
    
    // Fuzzy matching for common misspellings and partial matches
    const fuzzyScore = searchParts.reduce((score, part) => {
        // Check for common prefix
        if (cityLower.startsWith(part)) score += 40;
        
        // Check for contained words
        if (cityLower.includes(part)) score += 30;
        
        // Check for similar characters (basic fuzzy matching)
        const similarity = part.split('').filter(char => cityLower.includes(char)).length;
        score += (similarity / part.length) * 20;
        
        return score;
    }, 0);
    
    return Math.min(fuzzyScore, 85); // Cap fuzzy score below exact match scores
}

// Validation middleware
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

// Enhanced city search endpoint
app.get('/cities', validateCitySearch, async (req, res) => {
    try {
        const searchTerm = req.query.term.trim();
        console.log('Search term:', searchTerm);

        const cacheKey = `cities_${searchTerm.toLowerCase()}`;
        const cachedResults = cache.get(cacheKey);
        if (cachedResults) {
            return res.json(cachedResults);
        }

        // Prepare multiple search variations
        const searchVariations = [
            searchTerm,
            `${searchTerm} city`,
            // Add common prefixes/suffixes for better matching
            searchTerm.replace(/^new /i, 'nueva '), // Spanish variation
            searchTerm.replace(/^saint /i, 'st '), // Common abbreviation
        ];

        // Remove duplicates
        const uniqueSearches = [...new Set(searchVariations)];

        // Make parallel requests for each search variation
        const searches = uniqueSearches.map(term => 
            opencageBreaker.fire({
                method: 'get',
                url: 'https://api.opencagedata.com/geocode/v1/json',
                params: {
                    q: term,
                    key: process.env.OPENCAGE_API_KEY,
                    limit: 10,
                    no_annotations: 0,
                    language: 'en'
                }
            })
        );

        const searchResults = await Promise.allSettled(searches);
        let combinedResults = [];

        searchResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value.data?.results) {
                combinedResults.push(...result.value.data.results);
            }
        });

        // Enhanced city processing and scoring
        let cities = combinedResults
            .map(result => {
                const components = result.components;
                const annotations = result.annotations || {};
                const cityName = components.city || 
                               components.town || 
                               components.municipality ||
                               components.village ||
                               components.county;

                if (!cityName) return null;

                let score = 0;

                // Enhanced match quality scoring
                const matchQuality = calculateMatchQuality(cityName, searchTerm);
                score += matchQuality;

                // Population/importance boosts
                if (components.capital === 'yes') score += 200;
                if (components.state_capital === 'yes') score += 100;
                if (annotations.wikidata) score += 50;
                if (components._type === 'city') score += 50;

                // Extended list of major cities with scores
                const majorCities = {
                    'new york': 300,
                    'london': 300,
                    'paris': 280,
                    'tokyo': 280,
                    'los angeles': 260,
                    'chicago': 250,
                    'houston': 240,
                    'miami': 240,
                    'toronto': 240,
                    'sydney': 240,
                    'mexico city': 230,
                    'beijing': 230,
                    'shanghai': 230,
                    'dubai': 230,
                    'singapore': 230,
                    'hong kong': 230,
                    'seoul': 220,
                    'bangkok': 220,
                    'mumbai': 220,
                    'delhi': 220,
                    'istanbul': 220,
                    'moscow': 220,
                    'são paulo': 220,
                    'rio de janeiro': 220,
                    'buenos aires': 220,
                    'cairo': 220,
                    'lagos': 210,
                    'johannesburg': 210,
                    'melbourne': 210,
                    'vancouver': 210,
                    'montreal': 210,
                    'berlin': 210,
                    'madrid': 210,
                    'rome': 210,
                    'vienna': 210,
                    'amsterdam': 210,
                    'brussels': 200,
                    'stockholm': 200,
                    'copenhagen': 200,
                    'oslo': 200,
                    'helsinki': 200,
                    'warsaw': 200,
                    'prague': 200,
                    'budapest': 200,
                    'athens': 200,
                    'dublin': 200,
                    'lisbon': 200,
                    'barcelona': 200,
                    'milan': 200,
                    'munich': 200,
                    'hamburg': 200,
                    'frankfurt': 200,
                    'zurich': 200,
                    'geneva': 200,
                    'medellin': 190,
                    'bogota': 190,
                    'lima': 190,
                    'santiago': 190,
                    'caracas': 190,
                    'quito': 190,
                    'panama city': 190,
                    'san jose': 190,
                    'managua': 190,
                    'tegucigalpa': 190,
                    'san salvador': 190,
                    'guatemala city': 190
                };

                const cityLower = cityName.toLowerCase();
                if (majorCities[cityLower]) {
                    score += majorCities[cityLower];
                }

                // Country importance scoring
                const majorCountries = {
                    'united states': 100,
                    'united kingdom': 90,
                    'canada': 80,
                    'australia': 80,
                    'france': 70,
                    'germany': 70,
                    'japan': 70,
                    'china': 70,
                    'india': 70,
                    'brazil': 70,
                    'italy': 60,
                    'spain': 60,
                    'mexico': 60,
                    'argentina': 60,
                    'colombia': 60,
                    'peru': 60,
                    'chile': 60,
                    'venezuela': 60,
                    'ecuador': 55,
                    'panama': 55,
                    'costa rica': 55,
                    'nicaragua': 55,
                    'honduras': 55,
                    'el salvador': 55,
                    'guatemala': 55
                };

                const countryLower = (components.country || '').toLowerCase();
                if (majorCountries[countryLower]) {
                    score += majorCountries[countryLower];
                }

                return {
                    city: cityName,
                    state: components.state || components.province || components.region,
                    country: components.country,
                    latitude: result.geometry.lat,
                    longitude: result.geometry.lng,
                    score: score,
                    formatted: result.formatted,
                    type: components._type
                };
            })
            .filter(city => {
                if (!city) return false;
                
                const cityLower = city.city.toLowerCase();
                const searchParts = searchTerm.toLowerCase().split(' ');
                
                // Enhanced relevancy check
                return searchParts.some(part => {
                    if (part.length < 2) return false;
                    
                    // Check various parts of the address
                    return cityLower.includes(part) || 
                           (city.state && city.state.toLowerCase().includes(part)) ||
                           (city.country && city.country.toLowerCase().includes(part)) ||
                           // Add fuzzy matching for better results
                           calculateMatchQuality(cityLower, part) > 60;
                });
            })
            .sort((a, b) => b.score - a.score);

        // Remove duplicates while keeping highest scored version
        cities = Array.from(new Map(
            cities.map(city => [
                `${city.city.toLowerCase()}-${city.state || ''}-${city.country}`,
                city
            ])
        ).values());

        // Take top results and format response
        const formattedCities = cities.slice(0, 10).map(city => ({
            city: city.city,
            state: city.state,
            country: city.country,
            latitude: city.latitude,
            longitude: city.longitude,
            type: city.type
        }));

        // Cache the results
        cache.set(cacheKey, formattedCities);
        res.json(formattedCities);

    } catch (error) {
        console.error('Cities API error:', error.response?.data || error);
        res.status(500).json({ 
            error: 'Failed to fetch city data',
            details: error.message || 'Internal server error',
            suggestion: 'Please try again with a more specific search term'
        });
    }
});

// Weather endpoint remains the same as in your original code
app.get('/weather', async (req, res) => {
    // ... [Your existing weather endpoint code] ...
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Global error:', err.stack);
    res.status(500).json({ 
        error: 'Server error',
        message: 'An unexpected error occurred',
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Graceful shutdown handling
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