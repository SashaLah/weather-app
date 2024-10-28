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

const cache = new NodeCache({ 
    stdTTL: 3600,
    checkperiod: 600,
    useClones: false,
    deleteOnExpire: true
});

const app = express();
app.set('trust proxy', 1);

app.use(cors());
app.use(compression({
    level: 6,
    threshold: 1024
}));
app.use(express.json());
app.use(express.static('public'));
app.use(express.static(__dirname));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    trustProxy: true
});
app.use(limiter);

// Simplified weather categories
const weatherCategories = {
    SUNNY: [0, 1],
    PARTLY_CLOUDY: [2],
    CLOUDY: [3],
    FOGGY: [45, 48],
    RAINY: [51, 53, 55, 61, 63, 65],
    SNOWY: [71, 73, 75, 77],
    STORMY: [95, 96, 99]
};

// Direct and controversial weather traits
const weatherTraits = {
    0: { // Clear sky
        positive: "You naturally draw attention",
        negative: "but you're hot-headed and exhausting to be around"
    },
    1: { // Mainly clear
        positive: "You shine bright and grab attention",
        negative: "but your need for spotlight annoys everyone"
    },
    2: { // Partly cloudy
        positive: "You try to brighten others' days",
        negative: "but you're often blocked by your own inner darkness"
    },
    3: { // Overcast
        positive: "You have depth",
        negative: "but you bring down everyone's mood"
    },
    45: { // Foggy
        positive: "You're mysterious",
        negative: "but you confuse and frustrate people"
    },
    48: { // Foggy with frost
        positive: "You're cool and collected",
        negative: "but you're impossible to read or trust"
    },
    51: { // Light drizzle
        positive: "You're sensitive",
        negative: "but you cry at literally everything"
    },
    61: { // Light rain
        positive: "You're emotionally available",
        negative: "but your constant emotional outbursts are draining"
    },
    63: { // Moderate rain
        positive: "You feel everything deeply",
        negative: "but you're way too dramatic"
    },
    65: { // Heavy rain
        positive: "You're emotionally intense",
        negative: "but you're a complete drama queen"
    },
    71: { // Light snow
        positive: "You're uniquely beautiful",
        negative: "but you're cold and distant"
    },
    73: { // Moderate snow
        positive: "You're pure at heart",
        negative: "but you freeze people out"
    },
    75: { // Heavy snow
        positive: "You're striking and memorable",
        negative: "but you're ice cold and push everyone away"
    },
    95: { // Thunderstorm
        positive: "You're powerful and dynamic",
        negative: "but you create chaos wherever you go"
    },
    96: { // Thunderstorm with hail
        positive: "You're a force of nature",
        negative: "but you destroy everything in your path"
    },
    99: { // Heavy thunderstorm
        positive: "You're absolutely unforgettable",
        negative: "but you're overwhelming and destructive"
    }
};

// Direct temperature traits
function getTemperatureTraits(maxTemp) {
    if (maxTemp >= 40) {
        return {
            trait: "You're dangerously hot-headed and impossible when angry",
            mood: "Explosive"
        };
    } else if (maxTemp >= 35) {
        return {
            trait: "You're quick to anger and unbearable when mad",
            mood: "Hot-tempered"
        };
    } else if (maxTemp >= 30) {
        return {
            trait: "You run hot and get fired up easily",
            mood: "Intense"
        };
    } else if (maxTemp >= 25) {
        return {
            trait: "You're energetic but can be too much",
            mood: "Energetic"
        };
    } else if (maxTemp >= 20) {
        return {
            trait: "You're generally balanced, sometimes boring",
            mood: "Balanced"
        };
    } else if (maxTemp >= 15) {
        return {
            trait: "You're cool but can be too chill",
            mood: "Relaxed"
        };
    } else if (maxTemp >= 10) {
        return {
            trait: "You're detached and emotionally unavailable",
            mood: "Distant"
        };
    } else if (maxTemp >= 5) {
        return {
            trait: "You're cold and push people away",
            mood: "Cold"
        };
    } else {
        return {
            trait: "You're freezing cold and emotionally frozen",
            mood: "Frozen"
        };
    }
}

// Generate direct horoscope
function generateDirectHoroscope(weatherData) {
    const weathercode = weatherData.daily.weathercode[0];
    const maxTemp = weatherData.daily.temperature_2m_max[0];
    const precipitation = weatherData.daily.precipitation_sum[0];

    const weatherTrait = weatherTraits[weathercode] || weatherTraits[0];
    const tempTrait = getTemperatureTraits(maxTemp);

    const horoscope = {
        traits: [
            `${weatherTrait.positive} ${weatherTrait.negative}`,
            tempTrait.trait
        ]
    };

    // Add precipitation-based trait
    if (precipitation > 30) {
        horoscope.traits.push("You're drowning in emotions and exhausting to others");
    } else if (precipitation > 15) {
        horoscope.traits.push("You cry too much and make everyone uncomfortable");
    } else if (precipitation > 0) {
        horoscope.traits.push("You get emotional at the smallest things");
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

// Helper function to get historical data
async function getHistoricalData(latitude, longitude, month, day, startYear, endYear) {
    const cacheKey = `historical_${latitude}_${longitude}_${month}_${day}_${startYear}_${endYear}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) return cachedData;

    try {
        const dates = [];
        for (let year = startYear; year <= endYear; year++) {
            dates.push(`${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
        }

        const historicalData = [];
        const batchSize = 5;
        
        for (let i = 0; i < dates.length; i += batchSize) {
            const batch = dates.slice(i, i + batchSize);
            const batchPromises = batch.map(date => {
                const params = new URLSearchParams({
                    latitude,
                    longitude,
                    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode',
                    timezone: 'auto',
                    start_date: date,
                    end_date: date
                }).toString();

                return axios.get(`https://archive-api.open-meteo.com/v1/era5?${params}`)
                    .catch(error => ({ error, date }));
            });

            const results = await Promise.all(batchPromises);
            
            results.forEach((result, index) => {
                if (!result.error && result.data?.daily?.temperature_2m_max?.length) {
                    const year = parseInt(batch[index].split('-')[0]);
                    historicalData.push({
                        year,
                        maxTemp: result.data.daily.temperature_2m_max[0],
                        minTemp: result.data.daily.temperature_2m_min[0],
                        weatherCode: result.data.daily.weathercode[0],
                        precipitation: result.data.daily.precipitation_sum[0]
                    });
                }
            });
        }

        cache.set(cacheKey, historicalData, 86400);
        return historicalData;
    } catch (error) {
        console.error('Historical data fetch error:', error);
        return null;
    }
}

// Routes
app.get('/cities', validateCitySearch, async (req, res) => {
    try {
        const searchTerm = req.query.term.trim();
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
                return {
                    city: cityName,
                    state: components.state || components.province || components.region,
                    country: country,
                    latitude: result.geometry.lat,
                    longitude: result.geometry.lng,
                    formatted: result.formatted
                };
            })
            .filter(city => city !== null);

        const formattedCities = cities.slice(0, 10);
        cache.set(cacheKey, formattedCities);
        res.json(formattedCities);

    } catch (error) {
        console.error('Cities API error:', error.response?.data || error);
        res.status(500).json({ 
            error: 'Failed to fetch city data',
            message: error.message
        });
    }
});

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

        const timelineData = await getHistoricalData(latitude, longitude, month, day, startYear, endYear);
        
        if (!timelineData || timelineData.length === 0) {
            return res.status(404).json({
                error: 'No data available',
                message: 'Could not fetch historical weather data'
            });
        }

        // Analyze weather patterns
        const analysis = {
            weatherTypes: {},
            temperatures: {
                average: timelineData.reduce((sum, data) => sum + data.maxTemp, 0) / timelineData.length
            }
        };

        // Count weather types
        timelineData.forEach(data => {
            let type = 'UNKNOWN';
            for (const [category, codes] of Object.entries(weatherCategories)) {
                if (codes.includes(data.weatherCode)) {
                    type = category;
                    break;
                }
            }
            analysis.weatherTypes[type] = (analysis.weatherTypes[type] || 0) + 1;
        });

        // Convert to percentages
        const total = timelineData.length;
        Object.keys(analysis.weatherTypes).forEach(type => {
            analysis.weatherTypes[type] = {
                count: analysis.weatherTypes[type],
                percentage: Math.round((analysis.weatherTypes[type] / total) * 100)
            };
        });

        // Generate prediction
        const recentYears = timelineData.slice(-5);
        const weatherCounts = {};
        let totalTemp = 0;

        recentYears.forEach(data => {
            weatherCounts[data.weatherCode] = (weatherCounts[data.weatherCode] || 0) + 1;
            totalTemp += data.maxTemp;
        });

        const prediction = {
            weatherCode: parseInt(Object.entries(weatherCounts)
                .sort((a, b) => b[1] - a[1])[0][0]),
            temperature: totalTemp / recentYears.length
        };

        const response = {
            timeline: timelineData,
            analysis: analysis,
            prediction: prediction
        };

        cache.set(cacheKey, response, 86400);
        res.json(response);

    } catch (error) {
        console.error('Timeline API error:', error);
        res.status(500).json({ 
            error: 'Timeline API error',
            message: error.message
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

        const requestDate = new Date(date);
        const formattedDate = requestDate.toISOString().split('T')[0];
        
        const baseParams = new URLSearchParams({
            latitude,
            longitude,
            daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode',
            timezone: 'auto',
            start_date: formattedDate,
            end_date: formattedDate
        }).toString();

        const isHistorical = requestDate < new Date();
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

        weatherData.horoscope = generateDirectHoroscope(weatherData);
        
        const cacheDuration = isHistorical ? 86400 : 3600;
        cache.set(cacheKey, weatherData, cacheDuration);
        res.json(weatherData);

    } catch (error) {
        console.error('Weather API error:', error.response?.data || error);
        res.status(500).json({ 
            error: 'Weather API error',
            message: error.message
        });
    }
});

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