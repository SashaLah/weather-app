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

// Improved Cities endpoint with fixed search
app.get('/cities', async (req, res) => {
    try {
        const searchTerm = req.query.term;
        if (!searchTerm || searchTerm.length < 2) {
            return res.status(400).json({ error: 'Search term must be at least 2 characters' });
        }

        const cacheKey = `cities_${searchTerm.toLowerCase()}`;
        const cachedResults = cache.get(cacheKey);
        if (cachedResults) {
            return res.json(cachedResults);
        }

        // Modified search query for better results
        const response = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
            params: {
                q: `"${searchTerm}"`, // Exact term search
                key: process.env.OPENCAGE_API_KEY,
                limit: 25,
                no_annotations: 1,
                language: 'en',
                min_confidence: 3,
                countrycode: '',
                no_dedupe: 1,
                no_record: 1
            }
        });

        let cities = response.data.results
            .map(result => {
                const components = result.components;
                const cityName = components.city || 
                               components.town || 
                               components.municipality ||
                               components.village ||
                               components.suburb;

                if (!cityName) return null;

                // Calculate various scores for ranking
                const popScore = components.population ? 
                    Math.min(components.population / 1000000, 1) : 0;

                const nameMatchScore = cityName.toLowerCase() === searchTerm.toLowerCase() ? 1 :
                    cityName.toLowerCase().includes(searchTerm.toLowerCase()) ? 0.8 : 0;

                // Special handling for major cities
                const isMajorCity = components.city_type === 'major' || 
                                  components.capital === 'yes' ||
                                  (components.population && components.population > 1000000);

                return {
                    city: cityName,
                    state: components.state || components.province || components.region,
                    country: components.country,
                    latitude: result.geometry.lat,
                    longitude: result.geometry.lng,
                    confidence: result.confidence / 10,
                    isCapital: components.capital === 'yes' ? 1 : 0,
                    formatted: result.formatted,
                    population: components.population,
                    score: (nameMatchScore * 0.4) + 
                          (popScore * 0.3) + 
                          ((result.confidence / 10) * 0.2) + 
                          (isMajorCity ? 0.2 : 0) +
                          (components.capital === 'yes' ? 0.1 : 0)
                };
            })
            .filter(city => {
                return city !== null && 
                       city.city && 
                       city.country && 
                       city.city.toLowerCase().includes(searchTerm.toLowerCase());
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map(city => ({
                city: city.city,
                state: city.state,
                country: city.country,
                latitude: city.latitude,
                longitude: city.longitude
            }));

        // Fallback search if no results found
        if (cities.length === 0) {
            const broadResponse = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
                params: {
                    q: `${searchTerm} city major`,
                    key: process.env.OPENCAGE_API_KEY,
                    limit: 10,
                    no_annotations: 1,
                    language: 'en',
                    min_confidence: 1
                }
            });

            cities = broadResponse.data.results
                .map(result => ({
                    city: result.components.city || 
                          result.components.town || 
                          result.components.municipality,
                    state: result.components.state || 
                           result.components.province || 
                           result.components.region,
                    country: result.components.country,
                    latitude: result.geometry.lat,
                    longitude: result.geometry.lng
                }))
                .filter(city => city.city && city.country);
        }

        cache.set(cacheKey, cities);
        res.json(cities);

    } catch (error) {
        console.error('Cities API error:', error.response?.data || error);
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