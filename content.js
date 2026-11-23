/* All the words students read: the introduction, the five stages, the numbers
 * they are trying to reproduce from the published paper, and a glossary that
 * defines every term the activity uses. Kept separate from the code so it can
 * be edited without touching anything that runs. */
(function (root) {
  'use strict';

  var INTRO = {
    title: "Did Germany's nuclear phase-out increase CO₂ emissions?",
    subtitle: 'Replicating a 2025 synthetic-control study. About 45 minutes.',
    blocks: [
      { lead: 'What you are doing.',
        text: 'A paper published in PLOS ONE in 2025 estimated what Germany’s ' +
              'CO₂ emissions would have been if it had never shut down its nuclear ' +
              'reactors. Your group is going to rebuild that estimate from the authors’ ' +
              'own data and check whether the numbers come out the same. Replication is ' +
              'the job: not "is this a nice result", but "does it reproduce".' },
      { lead: 'Why it needs a method at all.',
        text: 'Germany shut its reactors down. There is no second Germany that kept ' +
              'them running, so there is nothing to compare against. The synthetic ' +
              'control method builds that missing comparison out of other countries.' },
      { lead: 'How the room works.',
        text: 'Everyone in your room shares one workspace. When you change something, ' +
              'the others see it immediately. There is one shared answer box per stage ' +
              'that you all write in together. If you want to try something without ' +
              'disturbing your group, use Explore on your own, then Rejoin the group.' },
      { lead: 'If a word is unfamiliar.',
        text: 'Press What do these words mean? at the top of the screen. Every term ' +
              'this activity uses is defined there in plain language — donor pool, ' +
              'RMSPE, V and W weights, placebo tests, all of it. Nothing in the ' +
              'activity assumes you already know them.' }
    ]
  };

  /* The numbers the paper printed. The whole point is to compare against these. */
  var PUBLISHED = {
    weights: { Czechia: 0.517, Netherlands: 0.312, France: 0.109, Sweden: 0.048, Spain: 0.014 },
    rmspePre: 0.218,
    rmspePost: 0.744,
    ratio: 3.415,
    runnerUp: { unit: 'Sweden', ratio: 1.747 },
    t0: 2011,
    donorCount: 11,
    coalPeak: '2013–2014',
    convergence: 2021
  };

  var STAGE_CONTENT = {
    s1: {
      heading: '1. What does the study claim?',
      blocks: [
        { lead: 'The case.',
          text: 'After the Fukushima accident in March 2011, Germany decided to shut ' +
                'down every nuclear reactor it had. Eight closed immediately; the last ' +
                'three closed in April 2023. Nuclear power produces almost no CO₂ ' +
                'while running, so the question is what replaced it.' },
        { lead: 'The question.',
          text: 'Did Germany’s CO₂ emissions from fossil fuels — coal, oil ' +
                'and gas — end up higher than they would have been without the ' +
                'phase-out? There is no second Germany that kept its reactors, so the ' +
                'study builds one.' },
        { lead: 'The method.',
          text: 'Take eleven European countries that had nuclear power and did not phase ' +
                'it out. Find the blend of them whose combined emissions best match ' +
                'Germany’s before 2011. After 2011 that blend — "synthetic ' +
                'Germany" — stands in for a Germany that kept its reactors.' },
        { lead: 'The claim.',
          text: 'Emissions fell in Germany after 2011, but they fell less than in ' +
                'synthetic Germany: the phase-out raised fossil-fuel CO₂ in the ' +
                'short run, mainly through coal. The authors also find the gap closes ' +
                'again by about 2021 as renewables expand.' },
        { lead: 'Your job on this screen.',
          text: 'The published model is already loaded. Check it against what the paper ' +
                'printed: the synthetic Germany should be 51.7% Czechia, 31.2% ' +
                'Netherlands, 10.9% France, 4.8% Sweden and 1.4% Spain. Look at the ' +
                'donor weights panel. Do they match?' }
      ],
      ask: 'Do the donor weights on your screen match the five the paper printed? ' +
           'And what does it mean that over half of "synthetic Germany" is one country?'
    },
    s2: {
      heading: '2. Build it yourself',
      blocks: [
        { lead: 'Two sets of weights.',
          text: 'Synthetic control involves two different things called weights, and ' +
                'mixing them up is the single most common confusion. The W weights say ' +
                'how much of each country goes into the blend. The V weights say how ' +
                'much each characteristic matters when deciding that blend.' },
        { lead: 'How they fit together.',
          text: 'You choose V. Given your V, the method solves for the W that best ' +
                'matches Germany on the characteristics you said were important. ' +
                'Different V, different W, different synthetic Germany.' },
        { lead: 'How good is the fit?',
          text: 'The pre-2011 RMSPE measures how far synthetic Germany sat from the real ' +
                'Germany before the phase-out, in tonnes of CO₂ per person. Smaller ' +
                'is better. If the two did not track each other before 2011, there is no ' +
                'reason to trust the comparison after it.' },
        { lead: 'Try this.',
          text: 'Switch the predictor weights to Set by hand and move the sliders. Watch ' +
                'the donor weights and the pre-2011 fit change together. Then press Let ' +
                'the data choose, which searches for the V with the best pre-2011 fit.' },
        { lead: 'The number to beat.',
          text: 'The paper reports a pre-2011 RMSPE of 0.218. See what you get with the ' +
                'published weights, and what you get when you let the data choose. They ' +
                'are not the same, and that difference is worth arguing about.' }
      ],
      ask: 'What pre-2011 fit did you get with the published weights, and what did you ' +
           'get when the data chose? Does either match the 0.218 the paper reports?'
    },
    s3: {
      heading: '3. Read off the effect',
      blocks: [
        { lead: 'The gap is the estimate.',
          text: 'The vertical distance between Germany and synthetic Germany after 2011 ' +
                'is the estimated effect of the phase-out. Above the line means Germany ' +
                'emitted more than it would have; below means less.' },
        { lead: 'The shaded band.',
          text: 'The band around synthetic Germany is one standard deviation of how far ' +
                'apart the two lines sat before 2011. It is a rough sense of how much ' +
                'daylight is normal for this model. A gap inside the band is not much ' +
                'of a finding.' },
        { lead: 'Which fuel?',
          text: 'Switch to By fuel. The total splits into coal, oil and gas. The paper ' +
                'says coal drives the increase and peaks around 2013–2014. Check ' +
                'whether yours does.' },
        { lead: 'And what replaced the nuclear power?',
          text: 'Switch to Electricity mix. This is the same comparison for electricity ' +
                'generated rather than CO₂ emitted. Watch nuclear fall and look at ' +
                'what rises to meet it — and when renewables take over from coal.' },
        { lead: 'The shape to check.',
          text: 'The paper describes a gap that opens after 2011, peaks in ' +
                '2013–2014, narrows from 2017, and has nearly closed by 2021. ' +
                'Does your version do that?' }
      ],
      ask: 'What is your group’s estimate of the effect, and how does it change ' +
           'from 2011 to 2023? Which fuel drives it, and does the gap close?'
    },
    s4: {
      heading: '4. Try to break it',
      blocks: [
        { lead: 'Why bother.',
          text: 'A gap on a chart is not yet evidence. It could be an accident of which ' +
                'countries went into the blend, or of which year you called the ' +
                'intervention. These three tests ask whether the result survives being ' +
                'poked.' },
        { lead: 'Placebo across countries.',
          text: 'Pretend each donor country had the phase-out instead, and run the whole ' +
                'thing again. If Germany’s gap is real it should be larger than the ' +
                'gaps that turn up where nothing happened. The paper reports Germany ' +
                'highest of twelve, at a ratio of 3.415, with Sweden second at 1.747.' },
        { lead: 'Placebo across dates.',
          text: 'Pretend the phase-out happened in 2000, 2007, 2008 or 2009 instead. ' +
                'Those are years when nothing changed, so a well-behaved model should ' +
                'show no jump. If a fake date produces a gap as big as the real one, the ' +
                'model is finding something other than the policy.' },
        { lead: 'Leave one out.',
          text: 'Drop one donor country at a time and refit. Over half of synthetic ' +
                'Germany is Czechia, so this is the test that matters most here. The ' +
                'paper says the result holds when Czechia is excluded. Check that claim ' +
                'yourself — carefully.' },
        { lead: 'Be specific about what breaks.',
          text: 'If a test damages the result, say which number moved and by how much. ' +
                '"It got worse" is not a finding; "the pre-2011 fit went from 0.25 to ' +
                '0.63 and the placebo ratio fell below 1" is.' }
      ],
      ask: 'Which test put the most pressure on the result? Name the number that moved ' +
           'and say whether the finding survived.'
    },
    s5: {
      heading: '5. Did it replicate?',
      blocks: [
        { lead: 'The question is not whether you liked it.',
          text: 'Replication asks a narrow question: using the authors’ own data and ' +
                'method, do you get the authors’ own numbers? Go through them one ' +
                'at a time and mark each as matched, close, or did not reproduce.' },
        { lead: 'The checklist.',
          text: 'Donor weights (Czechia 51.7%, Netherlands 31.2%, France 10.9%, Sweden ' +
                '4.8%, Spain 1.4%). Pre-2011 fit (0.218). Placebo ranking (Germany first ' +
                'of twelve, ratio 3.415). Coal peaking in 2013–2014. The gap closing ' +
                'by about 2021. Leave-one-out holding when Czechia is dropped.' },
        { lead: 'A failed replication is a result.',
          text: 'If a number does not reproduce, that is worth reporting plainly. It does ' +
                'not mean anyone cheated — small choices in how a model is specified ' +
                'move these numbers around, which is itself the lesson. Say what you ' +
                'found and what you think explains it.' },
        { lead: 'Write it as you would defend it.',
          text: 'One claim you are willing to argue for in the whole-class discussion, ' +
                'the evidence behind it, and the caveat you would attach.' }
      ],
      ask: 'Did the study replicate? Go through the checklist, say which numbers matched ' +
           'and which did not, and state the conclusion you are willing to defend.'
    }
  };

  /* Every term the activity uses, in plain language. */
  var GLOSSARY = [
    { group: 'The big idea', terms: [
      { term: 'Synthetic control',
        def: 'A way to estimate what would have happened to one place if some event had ' +
             'not occurred. You cannot rerun history, so you build a stand-in out of ' +
             'other places that did not experience the event, and compare.' },
      { term: 'Treated unit',
        def: 'The one that got the thing you are studying. Here, Germany, which went ' +
             'through the nuclear phase-out.' },
      { term: 'Counterfactual',
        def: 'The thing that did not happen but might have — Germany with its ' +
             'reactors still running. Synthetic Germany is an estimate of it.' },
      { term: 'Synthetic Germany',
        def: 'A weighted blend of other countries, built so that it tracked the real ' +
             'Germany closely before 2011. After 2011 it stands in for the Germany that ' +
             'never phased out nuclear power.' },
      { term: 'The gap',
        def: 'Real Germany minus synthetic Germany, year by year. After the intervention ' +
             'this gap is the estimated effect. Before it, the gap should be close to ' +
             'zero — that is what tells you the comparison is any good.' }
    ]},
    { group: 'Building the comparison', terms: [
      { term: 'Donor pool',
        def: 'The set of countries allowed into the blend. Here: Bulgaria, Czechia, ' +
             'Finland, France, Hungary, Netherlands, Slovak Republic, Slovenia, Spain, ' +
             'Sweden and Romania. All had nuclear power and none phased it out, so none ' +
             'of them got the treatment.' },
      { term: 'Donor countries',
        def: 'The individual members of the donor pool. Removing one is a robustness ' +
             'check, not a correction — you are asking whether the result depends ' +
             'on that country being there.' },
      { term: 'W weights (donor weights)',
        def: 'How much of each donor country goes into synthetic Germany. They are never ' +
             'negative and they add up to 100%. In the published model Czechia gets ' +
             '51.7%, so over half of the counterfactual is one country.' },
      { term: 'Predictors / characteristics to match on',
        def: 'The things synthetic Germany is made to resemble Germany on, averaged over ' +
             'the years before 2011: GDP per capita, cars per person, electricity use, ' +
             'electricity from fossil fuels, electricity from nuclear, temperature, ' +
             'industry’s share of the economy, population density, how urban the ' +
             'country is, energy intensity, and how much electricity households use.' },
      { term: 'V weights (predictor weights)',
        def: 'How much each characteristic counts when choosing the donor weights. ' +
             'Saying GDP matters a lot and temperature barely at all will produce a ' +
             'different blend than weighting them equally. This is the dial you turn by ' +
             'hand in stage 2.' },
      { term: 'Lagged outcome',
        def: 'Past values of the thing being studied, used as extra predictors — ' +
             'here, Germany’s emissions in 1990, 1994, 1998, 2002, 2006 and 2010. ' +
             'Matching on past emissions is usually what makes the fit good.' },
      { term: 'The nested problem (inner and outer loops)',
        def: 'Two optimisations stacked. The inner one: given V, find the W that best ' +
             'matches the predictors. The outer one: search over V for the one whose ' +
             'resulting W best reproduces Germany’s actual emissions before 2011. ' +
             'Let the data choose runs the outer loop.' },
      { term: 'Standardising the predictors',
        def: 'Dividing each characteristic by how much it varies across countries, so ' +
             'that GDP measured in thousands does not automatically swamp a share ' +
             'measured between 0 and 1.' }
    ]},
    { group: 'Judging the fit', terms: [
      { term: 'Pre-treatment / post-treatment period',
        def: 'Before and after the intervention. Here, 1990–2010 is pre and ' +
             '2011–2023 is post. The model is fitted only on the pre period; the ' +
             'post period is what you are trying to estimate.' },
      { term: 'Intervention year',
        def: 'The year the thing being studied began. 2011 for the phase-out. Changing it ' +
             'deliberately to a year when nothing happened is a placebo test.' },
      { term: 'RMSPE',
        def: 'Root Mean Squared Prediction Error. How far apart the real and synthetic ' +
             'lines sit on average, in the units of the outcome — here, tonnes of ' +
             'CO₂ per person. Square the yearly gaps, average them, take the square ' +
             'root. Smaller means a closer match.' },
      { term: 'Pre-2011 RMSPE',
        def: 'The fit before the intervention. This is a quality check on the model: a ' +
             'big number means synthetic Germany never resembled Germany, so nothing ' +
             'after 2011 can be trusted. Below about 0.3 is good here; above 0.6 means ' +
             'the model is broken.' },
      { term: 'Post-2011 RMSPE',
        def: 'The same calculation after the intervention. A large number here is what ' +
             'you would expect if the policy did something — but only if the ' +
             'pre-period number was small.' },
      { term: 'RMSPE ratio',
        def: 'Post divided by pre. It asks: did this unit diverge from its own synthetic ' +
             'version by much more after the event than before? A ratio near 1 means ' +
             'nothing changed. The ratio is what the placebo test ranks.' },
      { term: 'MSPE',
        def: 'The same thing as RMSPE without the final square root. Some papers report ' +
             'one, some the other.' }
    ]},
    { group: 'Testing whether it holds', terms: [
      { term: 'Placebo test in space (across countries)',
        def: 'Pretend each donor country had the intervention instead of Germany, and ' +
             'run the whole analysis again for each. If Germany’s divergence is real, ' +
             'it should be bigger than the divergences that show up in countries where ' +
             'nothing happened.' },
      { term: 'Rank and p-value',
        def: 'Sort all twelve countries by their RMSPE ratio. If Germany is first of ' +
             'twelve, that is as strong as this test can be with twelve countries, and ' +
             'corresponds to a p-value of 1/12 — about 0.083. With a small donor ' +
             'pool you cannot get below that, no matter how large the effect.' },
      { term: 'Placebo test in time (backdating)',
        def: 'Pretend the intervention happened earlier — 2000, 2007, 2008, 2009 ' +
             '— and refit using only the years before that fake date. Nothing ' +
             'happened in those years, so a trustworthy model should show no jump. If it ' +
             'does, the model is picking up something other than the policy.' },
      { term: 'Leave-one-out',
        def: 'Drop one donor country from the pool, rebuild, and see whether the answer ' +
             'changes. It tests whether the result rests on a single country. When one ' +
             'donor carries half the weight, this is the test that matters.' },
      { term: 'Robustness check',
        def: 'Any deliberate attempt to break your own result. If it survives, you ' +
             'believe it more. If it does not, you have learned something more useful ' +
             'than the original number.' }
    ]},
    { group: 'The assumptions underneath', terms: [
      { term: 'Good pre-treatment fit',
        def: 'The method only works if synthetic Germany tracked Germany closely before ' +
             '2011. Everything rests on this, which is why the pre-period RMSPE is the ' +
             'first number to look at.' },
      { term: 'No spillover (SUTVA)',
        def: 'The donor countries must not themselves be affected by Germany’s ' +
             'phase-out. Since European electricity grids are connected and Germany ' +
             'trades power with its neighbours, this assumption is worth questioning ' +
             'rather than accepting.' },
      { term: 'No other big shock at the same time',
        def: 'If something else hit Germany in 2011 but not the donors, the gap would ' +
             'capture that instead. The method cannot tell the difference.' },
      { term: 'Weights are not unique',
        def: 'Several quite different blends can fit the pre-period almost equally well ' +
             'while giving different estimates of the effect. This is a real limitation ' +
             'of the method, and you will run into it in stage 2.' }
    ]},
    { group: 'This study in particular', terms: [
      { term: 'The outcome variable',
        def: 'CO₂ emissions per person from burning fossil fuels — coal, oil ' +
             'and gas. Emissions from industrial processes such as cement are ' +
             'deliberately excluded, because those are not what replaces nuclear power.' },
      { term: 'Atomausstieg',
        def: 'The German nuclear phase-out. Decided after Fukushima and confirmed by the ' +
             'Bundestag on 30 June 2011; eight reactors closed at once and the last three ' +
             'in April 2023.' },
      { term: 'Energiewende',
        def: 'Germany’s broader energy transition, of which the phase-out was one ' +
             'part. It also included a large expansion of wind and solar, which is the ' +
             'reason the authors give for the gap closing after 2017.' },
      { term: 'The paper',
        def: 'Loiacono, Rizzo and Secomandi (2025), "Nuclear phase-out: Can we catch up ' +
             'on CO₂ emissions?", PLOS ONE. Every number in this activity is ' +
             'computed live from the dataset the authors published with it.' }
    ]}
  ];

  root.CONTENT = {
    INTRO: INTRO, STAGE_CONTENT: STAGE_CONTENT,
    GLOSSARY: GLOSSARY, PUBLISHED: PUBLISHED
  };
}(typeof self !== 'undefined' ? self : this));
