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
    CLOUDY: [2, 3],
    FOGGY: [45, 48],
    RAINY: [51, 53, 55, 61, 63, 65],
    SNOWY: [71, 73, 75, 77],
    STORMY: [95, 96, 99]
};

// Simplified weather traits
const weatherTraits = {
    0: { // Clear sky
        trait: "You shine bright and love attention",
        mood: "You're a ray of sunshine!"
    },
    1: { // Mainly clear
        trait: "You're optimistic and cheerful",
        mood: "You bring light to others"
    },
    2: { // Partly cloudy
        trait: "You're moody but balanced",
        mood: "You take life as it comes"
    },
    3: { // Overcast
        trait: "You're deep and thoughtful",
        mood: "You keep to yourself"
    },
    45: { // Foggy
        trait: "You're mysterious and hard to read",
        mood: "You keep people guessing"
    },
    48: { // Foggy with frost
        trait: "You're cool and mysterious",
        mood: "You're hard to figure out"
    },
    51: { // Light drizzle
        trait: "You're sensitive and emotional",
        mood: "You cry easily"
    },
    53: { // Moderate drizzle
        trait: "You wear your heart on your sleeve",
        mood: "You're not afraid to show feelings"
    },
    55: { // Dense drizzle
        trait: "You're super emotional",
        mood: "You're a big softie"
    },
    61: { // Slight rain
        trait: "You cry at movies",
        mood: "You feel things deeply"
    },
    63: { // Moderate rain
        trait: "You're very emotional",
        mood: "You let it all out"
    },
    65: { // Heavy rain
        trait: "You're extremely emotional",
        mood: "You're a drama queen"
    },
    71: { // Light snow
        trait: "You're gentle and pure",
        mood: "You're soft-hearted"
    },
    73: { // Moderate snow
        trait: "You're cold but beautiful",
        mood: "You're uniquely special"
    },
    75: { // Heavy snow
        trait: "You're ice cold when angry",
        mood: "You can be pretty cold"
    },
    95: { // Thunderstorm
        trait: "You're loud and dramatic",
        mood: "You love drama"
    },
    96: { // Thunderstorm with hail
        trait: "You're fierce and intense",
        mood: "You're a force of nature"
    },
    99: { // Heavy thunderstorm
        trait: "You're super dramatic",
        mood: "You're incredibly intense"
    }
};

// Simplified temperature traits
function getTemperatureTraits(maxTemp) {
    if (maxTemp > 35) {
        return {
            trait: "You're hot-headed and impulsive",
            mood: "You run hot!"
        };
    } else if (maxTemp > 30) {
        return {
            trait: "You're warm and energetic",
            mood: "You're full of energy"
        };
    } else if (maxTemp > 20) {
        return {
            trait: "You're balanced and steady",
            mood: "You keep it cool"
        };
    } else if (maxTemp > 10) {
        return {
            trait: "You're cool and collected",
            mood: "You stay chill"
        };
    } else {
        return {
            trait: "You're cold as ice",
            mood: "You're freezing cold"
        };
    }
}
// Helper functions
function analyzeWeatherHistory(weatherData) {
    const analysis = {
        weatherTypes: {},
        temperatures: {
            average: 0,
            highest: -Infinity,
            lowest: Infinity
        },
        summary: {}
    };

    weatherData.forEach(data => {
        // Get weather type
        let weatherType = 'UNKNOWN';
        for (const [category, codes] of Object.entries(weatherCategories)) {
            if (codes.includes(data.weatherCode)) {
                weatherType = category;
                break;
            }
        }

        // Count weather types
        analysis.weatherTypes[weatherType] = (analysis.weatherTypes[weatherType] || 0) + 1;

        // Track temperatures
        analysis.temperatures.average += data.maxTemp;
        analysis.temperatures.highest = Math.max(analysis.temperatures.highest, data.maxTemp);
        analysis.temperatures.lowest = Math.min(analysis.temperatures.lowest, data.maxTemp);
    });

    // Calculate averages and percentages
    const total = weatherData.length;
    analysis.temperatures.average /= total;

    // Convert counts to percentages
    Object.keys(analysis.weatherTypes).forEach(type => {
        const percentage = (analysis.weatherTypes[type] / total) * 100;
        analysis.weatherTypes[type] = {
            count: analysis.weatherTypes[type],
            percentage: Math.round(percentage)
        };
    });

    // Create simple summary
    analysis.summary = {
        mainWeather: Object.entries(analysis.weatherTypes)
            .sort((a, b) => b[1].count - a[1].count)[0][0],
        averageTemp: Math.round(analysis.temperatures.average)
    };

    return analysis;
}

function predictNextBirthday(weatherData) {
    const recentYears = weatherData.slice(-5);
    const weatherCounts = {};
    let totalTemp = 0;

    recentYears.forEach(data => {
        weatherCounts[data.weatherCode] = (weatherCounts[data.weatherCode] || 0) + 1;
        totalTemp += data.maxTemp;
    });

    const mostCommonWeather = Object.entries(weatherCounts)
        .sort((a, b) => b[1] - a[1])[0][0];

    return {
        weatherCode: parseInt(mostCommonWeather),
        temperature: totalTemp / recentYears.length
    };
}

function generateSimpleHoroscope(weatherData, historicalAnalysis) {
    const weathercode = weatherData.daily.weathercode[0];
    const maxTemp = weatherData.daily.temperature_2m_max[0];
    const precipitation = weatherData.daily.precipitation_sum[0];

    const weatherTrait = weatherTraits[weathercode] || weatherTraits[0];
    const tempTrait = getTemperatureTraits(maxTemp);

    const horoscope = {
        traits: [weatherTrait.trait, tempTrait.trait],
        mood: weatherTrait.mood
    };

    // Add rain personality if applicable
    if (precipitation > 20) {
        horoscope.traits.push("You're a total crybaby");
    } else if (precipitation > 10) {
        horoscope.traits.push("You get emotional easily");
    } else if (precipitation > 0) {
        horoscope.traits.push("You tear up sometimes");
    }

    // Add historical insight if available
    if (historicalAnalysis) {
        horoscope.history = `Your birthday is usually ${historicalAnalysis.summary.mainWeather.toLowerCase()} (${
            historicalAnalysis.weatherTypes[historicalAnalysis.summary.mainWeather].percentage
        }% of the time)`;
    }

    return horoscope;
}

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

function getWeatherDescription(weatherCode, maxTemp, precipitation) {
    const temp = maxTemp;
    let tempDesc = "";
    if (temp >= 35) tempDesc = "scorching hot";
    else if (temp >= 30) tempDesc = "very hot";
    else if (temp >= 25) tempDesc = "warm";
    else if (temp >= 20) tempDesc = "mild";
    else if (temp >= 15) tempDesc = "cool";
    else if (temp >= 10) tempDesc = "chilly";
    else if (temp >= 5) tempDesc = "cold";
    else tempDesc = "freezing cold";

    const weatherTypes = {
        0: "sunny", 1: "mostly clear", 2: "partly cloudy", 3: "cloudy",
        45: "foggy", 48: "frosty", 51: "drizzly", 53: "drizzly", 55: "drizzly",
        61: "rainy", 63: "rainy", 65: "very rainy", 71: "snowy", 73: "snowy",
        75: "very snowy", 95: "stormy", 96: "stormy", 99: "very stormy"
    };

    const weatherDesc = weatherTypes[weatherCode] || "";
    const rainDesc = precipitation > 0 ? ` with ${precipitation}mm of rain` : "";

    return `It was ${tempDesc} and ${weatherDesc}${rainDesc}`;
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

        const analysis = analyzeWeatherHistory(timelineData);
        const prediction = predictNextBirthday(timelineData);

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

        // Get historical context
        const month = requestDate.getMonth() + 1;
        const day = requestDate.getDate();
        const historicalData = await getHistoricalData(
            latitude,
            longitude,
            month,
            day,
            requestDate.getFullYear() - 10,
            requestDate.getFullYear()
        );
        
        const analysis = historicalData ? analyzeWeatherHistory(historicalData) : null;
        weatherData.horoscope = generateSimpleHoroscope(weatherData, analysis);
        weatherData.historical_analysis = analysis;

        const cacheDuration = isHistorical ? 86400 : 3600;
        cache.set(cacheKey, weatherData, cacheDuration);
        res.json(weatherData);

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