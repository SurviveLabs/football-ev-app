export default function handler(req, res) {
  // Handle CORS for local or cross-origin testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
  }

  try {
    const {
      leagueTier = 'major',
      homeTeam = 'Home Team',
      awayTeam = 'Away Team',
      homeScored,
      homeConceded,
      awayScored,
      awayConceded,
      formWeight = 5,
      customLine,
      bookieOdds = {}
    } = req.body;

    // 1. Validate numeric inputs
    const hGS = parseFloat(homeScored);
    const hGC = parseFloat(homeConceded);
    const aGS = parseFloat(awayScored);
    const aGC = parseFloat(awayConceded);
    const fWeight = Math.min(Math.max(parseFloat(formWeight) || 5, 1), 10);

    if ([hGS, hGC, aGS, aGC].some((val) => isNaN(val) || val < 0)) {
      return res.status(400).json({ error: 'Please provide valid non-negative numbers for all goal averages.' });
    }

    // 2. Calculate Expected Goals (xG) with Home-Field Advantage & Form Weighting
    // Baseline league average goals per team (~1.35) & standard Home Field Advantage (~1.12x)
    const HOME_ADVANTAGE = 1.12;
    const AWAY_FACTOR = 0.92;

    // Form weight scales the blend between offensive output and opponent defensive vulnerability
    // Higher form weight (towards 10) emphasizes the team's recent scoring rate slightly more
    const attackInfluence = 0.45 + (fWeight / 10) * 0.15; // Ranges from 0.465 to 0.60
    const defenseInfluence = 1 - attackInfluence;

    const rawHomeXG = (hGS * attackInfluence + aGC * defenseInfluence) * HOME_ADVANTAGE;
    const rawAwayXG = (aGS * attackInfluence + hGC * defenseInfluence) * AWAY_FACTOR;

    // Clamp xG to realistic bounds to prevent extreme skew
    const homeXG = Math.max(0.15, Math.min(rawHomeXG, 5.5));
    const awayXG = Math.max(0.15, Math.min(rawAwayXG, 5.5));

    // 3. Poisson PMF Helper
    const factorial = (n) => {
      if (n <= 1) return 1;
      let res = 1;
      for (let i = 2; i <= n; i++) res *= i;
      return res;
    };

    const poisson = (k, lambda) => {
      return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
    };

    // 4. Dixon-Coles Low-Score Correlation Adjustment (tau)
    // Standard empirical rho (-0.11) adjusts 0-0, 1-0, 0-1, and 1-1 probabilities
    const RHO = -0.11;
    const dixonColesTau = (x, y, lambda, mu, rho) => {
      if (x === 0 && y === 0) return 1 - lambda * mu * rho;
      if (x === 0 && y === 1) return 1 + lambda * rho;
      if (x === 1 && y === 0) return 1 + mu * rho;
      if (x === 1 && y === 1) return 1 - rho;
      return 1;
    };

    // 5. Generate 10x10 Scoreline Probability Matrix & Normalize
    const MAX_GOALS = 9;
    const matrix = [];
    let totalProbSum = 0;

    for (let h = 0; h <= MAX_GOALS; h++) {
      matrix[h] = [];
      for (let a = 0; a <= MAX_GOALS; a++) {
        const baseProb = poisson(h, homeXG) * poisson(a, awayXG);
        const tau = dixonColesTau(h, a, homeXG, awayXG, RHO);
        const adjustedProb = Math.max(0, baseProb * tau);
        matrix[h][a] = adjustedProb;
        totalProbSum += adjustedProb;
      }
    }

    // Normalize matrix so probabilities sum to exactly 1.0 (100%)
    let mostLikelyScore = { home: 0, away: 0, prob: 0 };
    for (let h = 0; h <= MAX_GOALS; h++) {
      for (let a = 0; a <= MAX_GOALS; a++) {
        matrix[h][a] /= totalProbSum;
        if (matrix[h][a] > mostLikelyScore.prob) {
          mostLikelyScore = { home: h, away: a, prob: matrix[h][a] };
        }
      }
    }

    // 6. Aggregate Market Probabilities
    let homeWin = 0;
    let draw = 0;
    let awayWin = 0;
    let bttsYes = 0;
    let over15 = 0;
    let under25 = 0;

    const parsedLine = customLine !== '' && customLine !== null && customLine !== undefined
      ? parseFloat(customLine)
      : null;
    const hasCustomLine = parsedLine !== null && !isNaN(parsedLine) && parsedLine > 0;

    let customOver = 0;
    let customUnder = 0;
    let customPush = 0; // Handles whole-number lines like 2.0 or 3.0

    for (let h = 0; h <= MAX_GOALS; h++) {
      for (let a = 0; a <= MAX_GOALS; a++) {
        const p = matrix[h][a];
        const totalGoals = h + a;

        // 1X2
        if (h > a) homeWin += p;
        else if (h === a) draw += p;
        else awayWin += p;

        // BTTS
        if (h > 0 && a > 0) bttsYes += p;

        // Default Goal Lines
        if (totalGoals > 1.5) over15 += p;
        if (totalGoals < 2.5) under25 += p;

        // Custom Goal Line (if provided)
        if (hasCustomLine) {
          if (totalGoals > parsedLine) customOver += p;
          else if (totalGoals < parsedLine) customUnder += p;
          else customPush += p;
        }
      }
    }

    // Re-normalize custom line in case of whole-goal push (e.g., Over/Under 2.0)
    if (hasCustomLine && customPush > 0) {
      const nonPushTotal = customOver + customUnder;
      if (nonPushTotal > 0) {
        customOver /= nonPushTotal;
        customUnder /= nonPushTotal;
      }
    }

    // 7. Build Markets List & Evaluate +EV
    const probGate = leagueTier === 'lower' ? 0.60 : 0.55;

    const evaluateMarket = (id, label, prob, oddInput) => {
      const cleanProb = Math.min(Math.max(prob, 0.001), 0.999);
      const fairOdds = 1 / cleanProb;
      const bOdd = parseFloat(oddInput);
      const hasBookieOdd = !isNaN(bOdd) && bOdd > 1.0;

      let evPercent = null;
      let isPositiveEV = false;
      let meetsGate = cleanProb >= probGate;

      if (hasBookieOdd) {
        // EV% = ((True Probability * Bookie Odds) - 1) * 100
        evPercent = (cleanProb * bOdd - 1) * 100;
        isPositiveEV = evPercent > 0 && meetsGate;
      }

      return {
        id,
        label,
        probability: Number((cleanProb * 100).toFixed(1)),
        fairOdds: Number(fairOdds.toFixed(2)),
        bookieOdds: hasBookieOdd ? Number(bOdd.toFixed(2)) : null,
        evPercent: evPercent !== null ? Number(evPercent.toFixed(1)) : null,
        meetsGate,
        isPositiveEV
      };
    };

    const markets = [
      evaluateMarket('1', `${homeTeam} Win (1)`, homeWin, bookieOdds['1']),
      evaluateMarket('X', 'Draw (X)', draw, bookieOdds['X']),
      evaluateMarket('2', `${awayTeam} Win (2)`, awayWin, bookieOdds['2']),
      evaluateMarket('BTTS_YES', 'Both Teams to Score (Yes)', bttsYes, bookieOdds['BTTS_YES'])
    ];
    
    if (hasCustomLine) {
      markets.push(
        evaluateMarket('CUSTOM_OVER', `Over ${parsedLine} Goals`, customOver, bookieOdds['CUSTOM_OVER']),
        evaluateMarket('CUSTOM_UNDER', `Under ${parsedLine} Goals`, customUnder, bookieOdds['CUSTOM_UNDER'])
      );
    } else {
      markets.push(
        evaluateMarket('OVER_15', 'Over 1.5 Goals', over15, bookieOdds['OVER_15']),
        evaluateMarket('UNDER_25', 'Under 2.5 Goals', under25, bookieOdds['UNDER_25'])
      );
    }

    return res.status(200).json({
      match: { homeTeam, awayTeam, leagueTier, probGate: probGate * 100 },
      expectedGoals: {
        home: Number(homeXG.toFixed(2)),
        away: Number(awayXG.toFixed(2)),
        total: Number((homeXG + awayXG).toFixed(2))
      },
      mostLikelyScore: {
        score: `${mostLikelyScore.home} - ${mostLikelyScore.away}`,
        probability: Number((mostLikelyScore.prob * 100).toFixed(1))
      },
      markets
    });
  } catch (error) {
    return res.status(500).json({ error: 'Calculation error: ' + error.message });
  }
}
