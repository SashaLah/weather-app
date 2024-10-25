const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const compression = require('compression');
const { query, validationResult } = require('express-validator');

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

// Weather code to personality trait mappings
const weatherTraits = {
    0: { // Clear sky
        traits: [
            "You have a bright and sunny personality",
            "You bring clarity to difficult situations",
            "You're naturally optimistic",
            "You thrive in the spotlight"
        ],
        mood: "Your energy radiates like the clear sky on your special day!"
    },
    1: { // Mainly clear
        traits: [
            "You're mostly straightforward but keep some mystery",
            "You have a calm and steady presence",
            "You're good at finding silver linings",
            "You appreciate life's simple pleasures"
        ],
        mood: "Like a day with gentle clouds, you bring both light and depth to those around you."
    },
    2: { // Partly cloudy
        traits: [
            "You have a complex and interesting personality",
            "You're adaptable to change",
            "You see both sides of every situation",
            "You're thoughtful and contemplative"
        ],
        mood: "Your versatile nature helps you navigate life's changing seasons."
    },
    3: { // Overcast
        traits: [
            "You're deep and introspective",
            "You have rich inner thoughts",
            "You're protective of those you love",
            "You have hidden depths that surprise people"
        ],
        mood: "Like an overcast sky, you carry depth and mystery that others find intriguing."
    },
    45: { // Foggy
        traits: [
            "You're mysterious and enigmatic",
            "You have a dreamy perspective on life",
            "You help others see things differently",
            "You're comfortable with uncertainty"
        ],
        mood: "Your mysterious nature adds intrigue to everyday situations."
    },
    51: { // Light drizzle
        traits: [
            "You're gentle and nurturing",
            "You have a subtle but lasting impact",
            "You're refreshing to be around",
            "You bring growth to everything you touch"
        ],
        mood: "Like a gentle drizzle, you nurture growth in others."
    },
    61: { // Rain
        traits: [
            "You're emotional and deeply feeling",
            "You cleanse negative energy",
            "You're naturally nurturing",
            "You help others grow and flourish"
        ],
        mood: "Your emotional depth brings renewal and growth to relationships."
    },
    71: { // Snow
        traits: [
            "You're pure-hearted and unique",
            "You transform environments you enter",
            "You bring magic to ordinary moments",
            "You have a peaceful presence"
        ],
        mood: "Like snowflakes, you bring unique beauty to the world."
    },
    95: { // Thunderstorm
        traits: [
            "You have a powerful presence",
            "You're energetic and dynamic",
            "You create lasting impressions",
            "You're a force of nature"
        ],
        mood: "Your powerful energy creates memorable moments wherever you go."
    }
};

// Temperature-based personality insights
function getTemperatureTraits(maxTemp, minTemp) {
    const avgTemp = (maxTemp + minTemp) / 2;
    
    if (avgTemp > 30) {
        return {
            traits: [
                "You have a fiery and passionate nature",
                "You bring warmth to all your relationships",
                "You thrive in high-energy situations",
                "You naturally motivate others"
            ],
            mood: "Your warm personality lights up any room you enter!"
        };
    } else if (avgTemp > 20) {
        return {
            traits: [
                "You have a warm and balanced personality",
                "You make others feel comfortable",
                "You're adaptable and easy-going",
                "You bring harmony to group situations"
            ],
            mood: "Your comfortable presence puts others at ease."
        };
    } else if (avgTemp > 10) {
        return {
            traits: [
                "You have a cool and collected nature",
                "You think clearly under pressure",
                "You're refreshing to be around",
                "You bring perspective to heated situations"
            ],
            mood: "Your cool composure helps others find balance."
        };
    } else {
        return {
            traits: [
                "You have a crystal-clear mind",
                "You stay cool in any situation",
                "You're refreshingly honest",
                "You preserve your energy well"
            ],
            mood: "Your crisp energy brings clarity to confusion."
        };
    }
}

function generateHoroscope(weatherData) {
    const weathercode = weatherData.daily.weathercode[0];
    const maxTemp = weatherData.daily.temperature_2m_max[0];
    const minTemp = weatherData.daily.temperature_2m_min[0];
    const precipitation = weatherData.daily.precipitation_sum[0];

    // Find closest matching weather code
    const weatherCodes = Object.keys(weatherTraits).map(Number);
    const closestWeatherCode = weatherCodes.reduce((prev, curr) => 
        Math.abs(curr - weathercode) < Math.abs(prev - weathercode) ? curr : prev
    );

    const weatherPersonality = weatherTraits[closestWeatherCode];
    const tempPersonality = getTemperatureTraits(maxTemp, minTemp);

    // Generate random indices for traits
    const weatherTraitIndex = Math.floor(Math.random() * weatherPersonality.traits.length);
    const tempTraitIndex = Math.floor(Math.random() * tempPersonality.traits.length);

    const horoscope = {
        weather_summary: weatherPersonality.mood,
        temperature_insight: tempPersonality.mood,
        personality_traits: [
            weatherPersonality.traits[weatherTraitIndex],
            tempPersonality.traits[tempTraitIndex]
        ]
    };

    // Add precipitation-based insights
    if (precipitation > 0) {
        horoscope.personality_traits.push(
            "You're not afraid to show your emotions",
            "You help others grow and flourish"
        );
    }

    return horoscope;
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

        if (isNaN(latitude) || isNaN(longitude)) {
            return res.status(400).json({ 
                error: 'Invalid coordinates',
                message: 'Latitude and longitude must be valid numbers' 
            });
        }

        const requestDate = new Date(date);
        if (isNaN(requestDate.getTime())) {
            return res.status(400).json({
                error: 'Invalid date',
                message: 'Please provide a valid date'
            });
        }

        const cacheKey = `weather_${latitude}_${longitude}_${date}`;
        const cachedWeather = cache.get(cacheKey);
        if (cachedWeather) {
            return res.json(cachedWeather);
        }

        const formatDate = (d) => d.toISOString().split('T')[0];
        const formattedDate = formatDate(requestDate);
        
        const baseParams = new URLSearchParams({
            latitude: latitude,
            longitude: longitude,
            daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode',
            timezone: 'auto',
            start_date: formattedDate,
            end_date: formattedDate
        }).toString();

        const today = new Date();
        const isHistorical = requestDate < today;
        
        const url = isHistorical
            ? `https://archive-api.open-meteo.com/v1/era5?${baseParams}`
            : `https://api.open-meteo.com/v1/forecast?${baseParams}`;

        const response = await axios.get(url);
        const weatherData = response.data;

        if (!weatherData.daily?.temperature_2m_max?.length) {
            return res.status(404).json({ 
                error: 'No data available',
                message: 'No weather data available for this date and location' 
            });
        }

        // Generate horoscope based on weather
        const horoscope = generateHoroscope(weatherData);

        // Add metadata to response
        weatherData.meta = {
            date: formattedDate,
            data_type: isHistorical ? 'historical' : 'forecast',
            location: {
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude)
            }
        };

        // Add horoscope to response
        weatherData.horoscope = horoscope;

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