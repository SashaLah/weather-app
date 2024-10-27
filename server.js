const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const compression = require('compression');
const { query, validationResult } = require('express-validator');
const crypto = require('crypto');

let envPath = process.env.NODE_ENV === 'production' ? '/etc/secrets/.env' : '.env';
require('dotenv').config({ path: envPath });

const cache = new NodeCache({ 
    stdTTL: 1800,
    checkperiod: 120
});

const resultsCache = new NodeCache({
    stdTTL: 86400 * 30, // 30 days
    checkperiod: 600
});

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static('public'));
app.use(express.static(__dirname));

// Weather code to personality trait mappings - Now more accurately tied to weather conditions
const weatherTraits = {
    clearSky: {
        codes: [0, 1],
        traits: [
            "You have a naturally bright and optimistic personality",
            "You bring clarity and warmth to those around you",
            "You shine brightest when helping others",
            "Your energy is infectious and uplifting"
        ],
        mood: "Like a clear sky, you bring light and warmth to everyone around you!"
    },
    partlyCloudy: {
        codes: [2],
        traits: [
            "You have a balanced and adaptable nature",
            "You see multiple sides of every situation",
            "You bring harmony to complex situations",
            "You're thoughtful and considerate"
        ],
        mood: "Like a partly cloudy day, you bring both sunshine and gentle shade!"
    },
    cloudy: {
        codes: [3],
        traits: [
            "You have deep wisdom and insight",
            "You're protective of those you care about",
            "You bring calm to stormy situations",
            "You're thoughtful and mysterious"
        ],
        mood: "Like clouds bringing needed shade, you offer comfort and protection."
    },
    foggy: {
        codes: [45, 48],
        traits: [
            "You have a mysterious and intriguing personality",
            "You help others see things from new perspectives",
            "You're comfortable with life's uncertainties",
            "You bring depth to shallow situations"
        ],
        mood: "Like fog that transforms familiar landscapes, you help others see things differently."
    },
    drizzle: {
        codes: [51, 53, 55],
        traits: [
            "You have a gentle and nurturing nature",
            "You bring subtle but meaningful change",
            "You're patient and persistent",
            "Your presence is softly refreshing"
        ],
        mood: "Like gentle rain that nurtures growth, you bring quiet transformation."
    },
    rain: {
        codes: [61, 63, 65, 80, 81, 82],
        traits: [
            "You're deeply emotional and caring",
            "You wash away negativity",
            "You help others grow and flourish",
            "You bring renewal and fresh starts"
        ],
        mood: "Like rain that brings new life, you help others flourish and grow!"
    },
    snow: {
        codes: [71, 73, 75, 77, 85, 86],
        traits: [
            "You have a pure and peaceful nature",
            "You transform environments you enter",
            "You bring magic to ordinary moments",
            "Your presence creates tranquility"
        ],
        mood: "Like snow that transforms the world, you bring magic and peace to those around you."
    },
    thunderstorm: {
        codes: [95, 96, 99],
        traits: [
            "You have a powerful and dynamic presence",
            "You're a force for positive change",
            "You bring excitement and energy",
            "You make lasting impressions"
        ],
        mood: "Like a powerful storm, you bring dramatic positive change to the world!"
    }
};

function getWeatherType(weatherCode) {
    for (const [type, data] of Object.entries(weatherTraits)) {
        if (data.codes.includes(weatherCode)) {
            return type;
        }
    }
    return 'clearSky'; // default if no match found
}

async function fetchHistoricalWeather(latitude, longitude, date) {
    const startYear = new Date(date).getFullYear();
    const currentYear = new Date().getFullYear();
    const currentDate = new Date();
    
    const monthDay = date.split('-').slice(1).join('-');
    const results = [];
    
    for (let year = startYear; year <= currentYear; year++) {
        const checkDate = `${year}-${monthDay}`;
        if (new Date(checkDate) > currentDate) continue;
        
        try {
            const response = await axios.get(
                `https://archive-api.open-meteo.com/v1/era5`,
                {
                    params: {
                        latitude,
                        longitude,
                        start_date: checkDate,
                        end_date: checkDate,
                        daily: 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum',
                        timezone: 'auto'
                    }
                }
            );
            
            if (response.data.daily) {
                results.push({
                    year,
                    weathercode: response.data.daily.weathercode[0],
                    temp_max: response.data.daily.temperature_2m_max[0],
                    temp_min: response.data.daily.temperature_2m_min[0],
                    precipitation: response.data.daily.precipitation_sum[0]
                });
            }
        } catch (error) {
            console.error(`Error fetching data for ${year}:`, error.message);
        }
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return results;
}

function generateHoroscope(weatherData) {
    const weathercode = weatherData.daily.weathercode[0];
    const weatherType = getWeatherType(weathercode);
    const traits = weatherTraits[weatherType];
    
    // Get random traits but ensure we don't repeat
    const selectedTraits = [...traits.traits]
        .sort(() => 0.5 - Math.random())
        .slice(0, 2);
    
    return {
        weather_type: weatherType,
        weather_summary: traits.mood,
        personality_traits: selectedTraits
    };
}

function generateShareableId(data) {
    const stringData = JSON.stringify({
        date: data.date,
        location: data.location,
        weather: data.weather
    });
    
    return crypto
        .createHash('sha256')
        .update(stringData)
        .digest('hex')
        .substring(0, 12);
}

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

function calculateMatchQuality(cityName, searchTerm) {
    const cityLower = cityName.toLowerCase();
    const searchLower = searchTerm.toLowerCase();
    
    if (cityLower === searchLower) return 100;
    if (cityLower.startsWith(searchLower)) return 95;
    
    const searchWords = searchLower.split(' ');
    const cityWords = cityLower.split(' ');
    
    if (searchWords.length > 0 && cityWords.length > 0) {
        if (cityWords[0].startsWith(searchWords[0])) {
            if (searchWords.length === 1) return 90;
            
            const allWordsMatch = searchWords.every((searchWord, index) => 
                cityWords[index] && cityWords[index].startsWith(searchWord)
            );
            if (allWordsMatch) return 85;
        }
    }
    
    if (cityLower.includes(searchLower)) return 70;
    return 0;
}

// Input validation
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

// Routes
app.get('/result/:id', (req, res) => {
    const resultData = resultsCache.get(req.params.id);
    if (resultData) {
        res.json(resultData);
    } else {
        res.status(404).json({ error: 'Result not found' });
    }
});

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
                limit: 20,
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

                const country = normalizeCountryName(components.country || '');
                let score = calculateMatchQuality(cityName, searchTerm);

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
            .filter(city => city && city.score > 0)
            .sort((a, b) => b.score - a.score);

        cities = Array.from(new Map(
            cities.map(city => [
                `${city.city.toLowerCase()}-${(city.state || '').toLowerCase()}-${city.country.toLowerCase()}`,
                city
            ])
        ).values());

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

        const cacheKey = `weather_${latitude}_${longitude}_${date}`;
        const cachedWeather = cache.get(cacheKey);
        if (cachedWeather) {
            return res.json(cachedWeather);
        }

        // Fetch current day weather
        const weatherData = await axios.get(
            `https://api.open-meteo.com/v1/forecast`,
            {
                params: {
                    latitude,
                    longitude,
                    start_date: date,
                    end_date: date,
                    daily: 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum',
                    timezone: 'auto'
                }
            }
        );

        // Fetch historical timeline
        const historicalData = await fetchHistoricalWeather(latitude, longitude, date);

        // Generate horoscope
        const horoscope = generateHoroscope(weatherData.data);

        // Create response object
        const responseData = {
            current: weatherData.data,
            historical: historicalData,
            horoscope
        };

        // Generate shareable ID
        const shareableId = generateShareableId({
            date,
            location: { latitude, longitude },
            weather: weatherData.data
        });

        // Cache the result with the shareable ID
        resultsCache.set(shareableId, responseData);
        responseData.shareableId = shareableId;

        // Cache the weather data
        cache.set(cacheKey, responseData);
        
        res.json(responseData);

    } catch (error) {
        console.error('Weather API error:', error);
        res.status(500).json({ 
            error: 'Weather API error',
            message: error.message
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