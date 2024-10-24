const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

let envPath;
if (process.env.NODE_ENV === 'production') {
    envPath = '/etc/secrets/.env';
} else {
    envPath = '.env';
}

require('dotenv').config({ path: envPath });

const cache = new NodeCache({ stdTTL: 1800 });

const app = express();
app.set('trust proxy', 1);
app.use(cors());
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

// Helper function to calculate match quality
function calculateMatchQuality(cityName, searchTerm) {
    const cityLower = cityName.toLowerCase();
    const searchLower = searchTerm.toLowerCase();
    const searchParts = searchLower.split(' ').filter(part => part.length > 0);

    // Perfect match
    if (cityLower === searchLower) return 100;

    // Starts with exact search term
    if (cityLower.startsWith(searchLower)) return 90;

    // All search parts match in order
    if (searchParts.every(part => {
        const index = cityLower.indexOf(part);
        return index !== -1;
    })) return 80;

    // First word matches exactly
    if (cityLower.startsWith(searchParts[0])) return 70;

    // Contains all search parts
    if (searchParts.every(part => cityLower.includes(part))) return 60;

    // Contains first search part
    if (cityLower.includes(searchParts[0])) return 50;

    return 0;
}

app.get('/cities', async (req, res) => {
    try {
        const searchTerm = req.query.term.trim();
        console.log('Search term:', searchTerm);

        if (!searchTerm || searchTerm.length < 2) {
            return res.status(400).json({ error: 'Search term must be at least 2 characters' });
        }

        const cacheKey = `cities_${searchTerm.toLowerCase()}`;
        const cachedResults = cache.get(cacheKey);
        if (cachedResults) {
            return res.json(cachedResults);
        }

        // Make multiple searches to improve results
        const searches = [
            // Primary search with original term
            axios.get('https://api.opencagedata.com/geocode/v1/json', {
                params: {
                    q: searchTerm,
                    key: process.env.OPENCAGE_API_KEY,
                    limit: 10,
                    no_annotations: 0,
                    language: 'en'
                }
            }),
            // Secondary search appending "city" to the term
            axios.get('https://api.opencagedata.com/geocode/v1/json', {
                params: {
                    q: `${searchTerm} city`,
                    key: process.env.OPENCAGE_API_KEY,
                    limit: 10,
                    no_annotations: 0,
                    language: 'en'
                }
            })
        ];

        const [primaryResults, secondaryResults] = await Promise.all(searches);
        const combinedResults = [...primaryResults.data.results, ...secondaryResults.data.results];

        let cities = combinedResults
            .map(result => {
                const components = result.components;
                const annotations = result.annotations || {};
                const cityName = components.city || 
                               components.town || 
                               components.municipality ||
                               components.county;

                if (!cityName) return null;

                let score = 0;

                // Basic match quality
                const matchQuality = calculateMatchQuality(cityName, searchTerm);
                score += matchQuality;

                // Population/importance boosts
                if (components.capital === 'yes') score += 200;
                if (components.state_capital === 'yes') score += 100;
                if (annotations.wikidata) score += 50;
                if (components._type === 'city') score += 50;
                
                // Country importance
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
                    'spain': 60
                };

                const countryLower = (components.country || '').toLowerCase();
                if (majorCountries[countryLower]) {
                    score += majorCountries[countryLower];
                }

                // Major city boost for well-known cities
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
                    'sydney': 240
                };

                const cityLower = cityName.toLowerCase();
                if (majorCities[cityLower]) {
                    score += majorCities[cityLower];
                }

                return {
                    city: cityName,
                    state: components.state || components.province || components.region,
                    country: components.country,
                    latitude: result.geometry.lat,
                    longitude: result.geometry.lng,
                    score: score,
                    formatted: result.formatted
                };
            })
            .filter(city => {
                if (!city) return false;
                
                // Enhanced relevancy check
                const cityLower = city.city.toLowerCase();
                const searchParts = searchTerm.toLowerCase().split(' ');
                
                // Check if city name contains all search parts
                return searchParts.every(part => 
                    cityLower.includes(part) || 
                    (city.state && city.state.toLowerCase().includes(part)) ||
                    (city.country && city.country.toLowerCase().includes(part))
                );
            })
            .sort((a, b) => b.score - a.score);

        // Remove duplicates, keeping highest scored version
        cities = Array.from(new Map(
            cities.map(city => [
                `${city.city.toLowerCase()}-${city.country}`,
                city
            ])
        ).values());

        // Take top 10 results
        cities = cities.slice(0, 10).map(city => ({
            city: city.city,
            state: city.state,
            country: city.country,
            latitude: city.latitude,
            longitude: city.longitude
        }));

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

        const response = await axios.get(url, { timeout: 5000 });
        const weatherData = response.data;

        if (!weatherData.daily?.temperature_2m_max?.length) {
            return res.status(404).json({ 
                error: 'No data available',
                message: 'No weather data available for this date and location' 
            });
        }

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