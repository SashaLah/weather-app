const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

// Configure environment based on NODE_ENV
let envPath;
if (process.env.NODE_ENV === 'production') {
    envPath = '/etc/secrets/.env';
} else {
    envPath = '.env';
}

require('dotenv').config({ path: envPath });

// Initialize cache with 30 minute TTL
const cache = new NodeCache({ stdTTL: 1800 });

const app = express();

// Trust proxy
app.set('trust proxy', 1);

app.use(cors());
app.use(express.static('public'));
app.use(express.static(__dirname));

// Middleware for logging requests
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Updated Rate limiting configuration
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: true
});

app.use(limiter);

// Cities endpoint with detailed debugging
app.get('/cities', async (req, res) => {
    try {
        console.log('\n=== Starting City Search ===');
        const searchTerm = req.query.term;
        console.log('Search term received:', searchTerm);

        if (!searchTerm || searchTerm.length < 2) {
            console.log('Search term too short');
            return res.status(400).json({ error: 'Search term must be at least 2 characters' });
        }

        // Check cache
        const cacheKey = `cities_${searchTerm.toLowerCase()}`;
        const cachedResults = cache.get(cacheKey);
        if (cachedResults) {
            console.log('Returning cached results:', cachedResults);
            return res.json(cachedResults);
        }

        console.log('Making API request to OpenCage');
        console.log('API Key present:', !!process.env.OPENCAGE_API_KEY);

        // Make the API request
        const response = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
            params: {
                q: searchTerm,
                key: process.env.OPENCAGE_API_KEY,
                limit: 25,
                no_annotations: 1,
                language: 'en',
                min_confidence: 3,
                type: 'city'
            }
        });

        console.log('\nAPI Response Status:', response.status);
        console.log('Total results:', response.data.results.length);
        console.log('Rate limit info:', {
            remaining: response.data.rate?.remaining,
            limit: response.data.rate?.limit
        });

        let cities = response.data.results
            .map(result => {
                console.log('\nProcessing result:', {
                    formatted: result.formatted,
                    components: result.components,
                    confidence: result.confidence
                });

                const cityName = result.components.city || 
                               result.components.town || 
                               result.components.municipality;

                if (!cityName) {
                    console.log('No city name found in result');
                    return null;
                }

                const city = {
                    city: cityName,
                    state: result.components.state || 
                           result.components.province || 
                           result.components.region,
                    country: result.components.country,
                    latitude: result.geometry.lat,
                    longitude: result.geometry.lng,
                    confidence: result.confidence,
                    type: result.components._type
                };

                console.log('Processed city:', city);
                return city;
            })
            .filter(city => {
                if (!city) {
                    return false;
                }
                const matches = city.city.toLowerCase().includes(searchTerm.toLowerCase());
                console.log(`Filtering city: ${city.city} - Matches search term: ${matches}`);
                return matches;
            })
            .sort((a, b) => {
                // Prioritize exact matches
                const aExact = a.city.toLowerCase() === searchTerm.toLowerCase();
                const bExact = b.city.toLowerCase() === searchTerm.toLowerCase();
                
                console.log(`Comparing: ${a.city} (${a.confidence}) vs ${b.city} (${b.confidence})`);
                
                if (aExact !== bExact) {
                    return bExact ? 1 : -1;
                }
                return b.confidence - a.confidence;
            })
            .slice(0, 10);

        console.log('\nFinal results:', cities);
        
        // If no results, try a broader search
        if (cities.length === 0) {
            console.log('\nNo results found, trying broader search');
            const broadResponse = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
                params: {
                    q: `${searchTerm} city`,
                    key: process.env.OPENCAGE_API_KEY,
                    limit: 10,
                    no_annotations: 1,
                    language: 'en'
                }
            });

            console.log('Broad search results:', broadResponse.data.results.length);
            
            cities = broadResponse.data.results
                .map(result => {
                    const city = {
                        city: result.components.city || 
                              result.components.town || 
                              result.components.municipality,
                        state: result.components.state || 
                               result.components.province || 
                               result.components.region,
                        country: result.components.country,
                        latitude: result.geometry.lat,
                        longitude: result.geometry.lng
                    };
                    console.log('Broad search processed city:', city);
                    return city;
                })
                .filter(city => city.city && city.country);
        }

        cache.set(cacheKey, cities);
        console.log('\n=== City Search Complete ===\n');
        res.json(cities);

    } catch (error) {
        console.error('Cities API error:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
        });
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
        console.error('Weather API error:', error.response?.data || error);
        
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
    console.error('Global error:', err.stack);
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