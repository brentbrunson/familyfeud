// Starter game used for new games. All point values are made up for fun, not real survey results.
module.exports = {
  title: "Thanksgiving Family Feud",
  logo: "",
  teams: ["Team Turkey", "Team Pie"],
  rounds: [
    {
      title: "Round 1",
      mult: 1,
      question: "Name something you'd find on a Thanksgiving table.",
      answers: [["Turkey", 38], ["Mashed potatoes", 22], ["Stuffing", 17], ["Cranberry sauce", 11], ["Pie", 8], ["Rolls", 4]]
    },
    {
      title: "Round 2",
      mult: 2,
      question: "Name something people do after Thanksgiving dinner.",
      answers: [["Take a nap", 33], ["Watch football", 27], ["Do the dishes", 16], ["Eat leftovers", 12], ["Play games", 8], ["Go shopping", 4]]
    },
    {
      title: "Round 3",
      mult: 3,
      question: "Name something that can go wrong on Thanksgiving Day.",
      answers: [["The turkey is dry or burnt", 30], ["Someone forgets a dish", 24], ["Family arguments", 20], ["Running out of something", 14], ["Guests arrive late", 8], ["Smoke alarm goes off", 4]]
    }
  ],
  fastMoney: {
    target: 200,
    p1Seconds: 20,
    p2Seconds: 25,
    questions: [
      { q: "Name a Thanksgiving side dish.", answers: [["Mashed potatoes", 35], ["Stuffing", 25], ["Green bean casserole", 18], ["Sweet potatoes", 12], ["Mac and cheese", 10]] },
      { q: "Name a pie served at Thanksgiving.", answers: [["Pumpkin", 45], ["Pecan", 25], ["Apple", 20], ["Sweet potato", 6], ["Cherry", 4]] },
      { q: "Name something people say they are thankful for.", answers: [["Family", 40], ["Health", 25], ["Friends", 15], ["Food", 12], ["Home", 8]] },
      { q: "Name something you'd put in a leftover turkey sandwich.", answers: [["Turkey", 40], ["Stuffing", 25], ["Cranberry sauce", 15], ["Gravy", 12], ["Mayo", 8]] },
      { q: "Name something people fight over at Thanksgiving.", answers: [["The TV remote", 30], ["The last piece of pie", 28], ["Politics", 20], ["Seating", 12], ["Who cleans up", 10]] }
    ]
  }
};
