const fs = require('fs');
const path = require('path');
const compression = require('compression');
const { query, validationResult } = require('express-validator');
const NodeCache = require('node-cache');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

let envPath = process.env.NODE_ENV === 'production' ? '/etc/secrets/.env' : '.env';
require('dotenv').config({ path: envPath });

// Enhanced cache configuration with longer TTL for historical data
const cache = new NodeCache({ 
    stdTTL: 3600, // 1 hour default TTL
    checkperiod: 600, // Check for expired keys every 10 minutes
    useClones: false, // Disable cloning for better performance
    deleteOnExpire: true
});

// Initialize Express with optimized middleware
const app = express();
app.set('trust proxy', 1);

// Middleware setup
app.use(cors());
app.use(compression({
    level: 6,
    threshold: 1024
}));
app.use(express.json());
app.use(express.static('public'));
app.use(express.static(__dirname));

// Rate limiting configuration
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: true
});
app.use(limiter);

// Complete weather traits object
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
    48: { // Foggy with frost
        traits: [
            "You combine mystery with sharp clarity",
            "You see beauty in subtle things",
            "You have a cool, collected demeanor",
            "You bring fresh perspectives"
        ],
        mood: "Your unique perspective helps others see the world in new ways."
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
    53: { // Moderate drizzle
        traits: [
            "You provide steady support",
            "You're consistently reliable",
            "You help things grow and flourish",
            "You have a calming presence"
        ],
        mood: "Your steady presence helps others thrive and grow."
    },
    55: { // Dense drizzle
        traits: [
            "You're deeply nurturing",
            "You have a powerful impact on others",
            "You're intensely caring",
            "You create environments where others flourish"
        ],
        mood: "Your nurturing nature creates positive change in others' lives."
    },
    61: { // Slight rain
        traits: [
            "You're emotional and deeply feeling",
            "You cleanse negative energy",
            "You're naturally nurturing",
            "You help others grow and flourish"
        ],
        mood: "Your emotional depth brings renewal and growth to relationships."
    },
    63: { // Moderate rain
        traits: [
            "You have strong emotional intelligence",
            "You wash away others' troubles",
            "You're deeply compassionate",
            "You bring renewal to situations"
        ],
        mood: "Your presence brings refreshing change to any situation."
    },
    65: { // Heavy rain
        traits: [
            "You have powerful emotions",
            "You create major positive changes",
            "You're intensely passionate",
            "You have a transformative presence"
        ],
        mood: "Your powerful presence transforms situations and inspires others."
    },
    71: { // Slight snow
        traits: [
            "You're pure-hearted and unique",
            "You transform environments you enter",
            "You bring magic to ordinary moments",
            "You have a peaceful presence"
        ],
        mood: "Like snowflakes, you bring unique beauty to the world."
    },
    73: { // Moderate snow
        traits: [
            "You create magical environments",
            "You transform situations beautifully",
            "You bring peace and tranquility",
            "You have a magical effect on others"
        ],
        mood: "Your presence transforms ordinary moments into magical experiences."
    },
    75: { // Heavy snow
        traits: [
            "You create profound transformations",
            "You bring deep peace to others",
            "You have a powerful calming presence",
            "You create magical environments"
        ],
        mood: "Your presence creates profound and beautiful transformations."
    },
    95: { // Thunderstorm
        traits: [
            "You have a powerful presence",
            "You're energetic and dynamic",
            "You create lasting impressions",
            "You're a force of nature"
        ],
        mood: "Your powerful energy creates memorable moments wherever you go."
    },
    96: { // Thunderstorm with hail
        traits: [
            "You're incredibly impactful",
            "You leave lasting impressions",
            "You have a dramatic presence",
            "You create unforgettable moments"
        ],
        mood: "Your dramatic presence leaves unforgettable impressions on others."
    },
    99: { // Heavy thunderstorm
        traits: [
            "You have an extremely powerful presence",
            "You create major transformations",
            "You're unforgettable to others",
            "You're a true force of nature"
        ],
        mood: "Your incredible presence creates powerful transformations in others' lives."
    }
};

// Complete temperature traits function
function getTemperatureTraits(maxTemp, minTemp) {
    const avgTemp = (maxTemp + minTemp) / 2;
    
    if (avgTemp > 35) {
        return {
            traits: [
                "You have an incredibly energetic personality",
                "Your passion burns bright and hot",
                "You bring intense energy to everything",
                "You naturally ignite others' enthusiasm"
            ],
            mood: "Your fiery personality ignites passion in others!"
        };
    } else if (avgTemp > 30) {
        return {
            traits: [
                "You have a fiery and passionate nature",
                "You bring warmth to all your relationships",
                "You thrive in high-energy situations",
                "You naturally motivate others"
            ],
            mood: "Your warm personality lights up any room you enter!"
        };
    } else if (avgTemp > 25) {
        return {
            traits: [
                "You have a warm and energetic personality",
                "You create comfortable environments",
                "You bring out the best in others",
                "You naturally encourage growth"
            ],
            mood: "Your warm presence helps others flourish and grow."
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
    } else if (avgTemp > 15) {
        return {
            traits: [
                "You have a cool and collected nature",
                "You think clearly under pressure",
                "You're refreshing to be around",
                "You bring perspective to heated situations"
            ],
            mood: "Your cool composure helps others find balance."
        };
    } else if (avgTemp > 10) {
        return {
            traits: [
                "You have a crisp and clear personality",
                "You bring fresh perspectives",
                "You help others think clearly",
                "You're naturally refreshing"
            ],
            mood: "Your crisp energy brings clarity to confusion."
        };
    } else if (avgTemp > 5) {
        return {
            traits: [
                "You have a sharp and clear mind",
                "You cut through confusion easily",
                "You bring clarity to others",
                "You're naturally precise"
            ],
            mood: "Your sharp clarity helps others see truth."
        };
    } else {
        return {
            traits: [
                "You have a crystal-clear mind",
                "You stay cool in any situation",
                "You're refreshingly honest",
                "You preserve your energy well"
            ],
            mood: "Your cool clarity brings truth to light."
        };
    }
}

// Complete horoscope generation function
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
        if (precipitation > 30) {
            horoscope.personality_traits.push(
                "You have profound emotional depth",
                "You create powerful transformations in others"
            );
        } else if (precipitation > 15) {
            horoscope.personality_traits.push(
                "You have strong emotional intelligence",
                "You help others grow and develop"
            );
        } else {
            horoscope.personality_traits.push(
                "You're not afraid to show your emotions",
                "You help others grow and flourish"
            );
        }
    }

    return horoscope;
}

// Utility functions
function normalizeCountryName(country) {
    const countryMappings = {
        'united states of america': 'united states',
        'usa': 'united states',
        'u.s.a.': 'united states',
        'u.s.': 'united states',
        'uk': 'united kingdom',
        'great britain': 'united kingdom',
        'england': 'united kingdom',
        'britain': 'united kingdom'
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

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Cities endpoint
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
                    score: score
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

// New optimized timeline endpoint
app.get('/weather/timeline', async (req, res) => {
    try {
        const { latitude, longitude, month, day, startYear, endYear } = req.query;

        if (!latitude || !longitude || !month || !day || !startYear || !endYear) {
            return res.status(400).json({ 
                error: 'Missing parameters',
                message: 'All timeline parameters are required' 
            });
        }

        const cacheKey = `timeline_${latitude}_${longitude}_${month}_${day}_${startYear}_${endYear}`;
        const cachedTimeline = cache.get(cacheKey);
        if (cachedTimeline) {
            return res.json(cachedTimeline);
        }

        const dates = [];
        for (let year = parseInt(startYear); year <= parseInt(endYear); year++) {
            dates.push(`${year}-${month}-${day}`);
        }

        const batchSize = 5;
        const batches = [];
        for (let i = 0; i < dates.length; i += batchSize) {
            const batch = dates.slice(i, i + batchSize);
            batches.push(batch);
        }

        const timelineData = [];
        const axiosConfig = {
            timeout: 10000,
            retries: 3,
            retryDelay: 1000
        };

        await Promise.all(batches.map(async (batch) => {
            const batchPromises = batch.map(date => {
                const baseParams = new URLSearchParams({
                    latitude,
                    longitude,
                    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode',
                    timezone: 'auto',
                    start_date: date,
                    end_date: date
                }).toString();

                return axios.get(`https://archive-api.open-meteo.com/v1/era5?${baseParams}`, axiosConfig)
                    .catch(error => ({ error, date }));
            });

            const batchResults = await Promise.all(batchPromises);
            
            batchResults.forEach((result, index) => {
                if (!result.error && result.data?.daily?.temperature_2m_max?.length) {
                    const year = parseInt(batch[index].split('-')[0]);
                    timelineData.push({
                        year,
                        maxTemp: result.data.daily.temperature_2m_max[0],
                        minTemp: result.data.daily.temperature_2m_min[0],
                        weatherCode: result.data.daily.weathercode[0],
                        precipitation: result.data.daily.precipitation_sum[0]
                    });
                }
            });
        }));

        // Sort timeline data chronologically
        timelineData.sort((a, b) => a.year - b.year);

        // Cache timeline data for 24 hours
        cache.set(cacheKey, timelineData, 86400);
        res.json(timelineData);

    } catch (error) {
        console.error('Timeline API error:', error);
        res.status(500).json({ 
            error: 'Timeline API error',
            message: error.message || 'Failed to fetch timeline data'
        });
    }
});

// Original weather endpoint for single date queries
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

        weatherData.meta = {
            date: formattedDate,
            data_type: isHistorical ? 'historical' : 'forecast',
            location: {
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude)
            }
        };

        weatherData.horoscope = generateHoroscope(weatherData);

        // Cache for 1 hour by default, but historical data can be cached longer
        const cacheDuration = isHistorical ? 86400 : 3600;
        cache.set(cacheKey, weatherData, cacheDuration);
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

// Basic routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Global error handler
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