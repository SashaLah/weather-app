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

app.get('/cities', async (req, res) => {
    try {
        const searchTerm = req.query.term.toLowerCase();
        console.log('Search term:', searchTerm);

        if (!searchTerm || searchTerm.length < 2) {
            return res.status(400).json({ error: 'Search term must be at least 2 characters' });
        }

        const cacheKey = `cities_${searchTerm}`;
        const cachedResults = cache.get(cacheKey);
        if (cachedResults) {
            return res.json(cachedResults);
        }

        const response = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
            params: {
                q: searchTerm,
                key: process.env.OPENCAGE_API_KEY,
                limit: 20,
                no_annotations: 0,
                language: 'en'
            }
        });

        let cities = response.data.results
            .map(result => {
                const components = result.components;
                const annotations = result.annotations || {};
                const cityName = components.city || 
                               components.town || 
                               components.municipality;

                if (!cityName) return null;

                let score = 0;

                if (components.capital) score += 50;
                if (components._type === 'city') score += 30;
                if (components._type === 'neighbourhood') score -= 20;

                const normalizedCityName = cityName.toLowerCase();
                if (normalizedCityName === searchTerm) score += 50;
                if (normalizedCityName.startsWith(searchTerm)) score += 30;
                
                const majorCountries = ['united states', 'united kingdom', 'canada', 'australia', 
                                      'france', 'germany', 'italy', 'spain', 'japan', 'china'];
                if (components.country && majorCountries.includes(components.country.toLowerCase())) {
                    score += 10;
                }

                if (annotations.flag) score += 10;
                if (components.state_capital) score += 20;
                if (annotations.wikidata) score += 15;

                if (components._type === 'village' || components._type === 'hamlet') score -= 30;

                return {
                    city: cityName,
                    state: components.state || components.province || components.region,
                    country: components.country,
                    latitude: result.geometry.lat,
                    longitude: result.geometry.lng,
                    score: score,
                    isCapital: !!components.capital,
                    type: components._type
                };
            })
            .filter(city => {
                if (!city) return false;
                const name = city.city.toLowerCase();
                return name.includes(searchTerm) || 
                       searchTerm.includes(name) || 
                       name.startsWith(searchTerm.split(' ')[0]);
            })
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                
                const aName = a.city.toLowerCase();
                const bName = b.city.toLowerCase();
                const aExact = aName === searchTerm;
                const bExact = bName === searchTerm;
                if (aExact !== bExact) return bExact ? 1 : -1;
                
                return aName.length - bName.length;
            })
            .slice(0, 10)
            .map(city => ({
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